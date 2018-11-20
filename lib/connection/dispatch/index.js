const EventEmitter = require('events'),
	path = require('path'),
	util = require('util'),
	binarySearch = require('binary-search'),
	{ revisions, protocol, sysmsg } = require('tera-data-parser'),
	types = Object.values(require('tera-data-parser').types),
	log = require('../../logger'),
	Wrapper = require('./wrapper')

protocol.load(require.resolve('tera-data'))

const latestDefVersion = new Map()

if(protocol.messages) {
	for(const [name, defs] of protocol.messages) {
		latestDefVersion.set(name, Math.max(...defs.keys()))
	}
}

function* iterateHooks(globalHooks = [], codeHooks = []) {
	const globalHooksIterator = globalHooks[Symbol.iterator](); // .values()
	const codeHooksIterator = codeHooks[Symbol.iterator](); // .values()

	let nextGlobalHook = globalHooksIterator.next()
	let nextCodeHook = codeHooksIterator.next()

	while (!nextGlobalHook.done || !nextCodeHook.done) {
		const globalHookGroup = nextGlobalHook.value
		const codeHookGroup = nextCodeHook.value

		if(globalHookGroup && (!codeHookGroup || globalHookGroup.order <= codeHookGroup.order)) {
			yield* globalHookGroup.hooks
			nextGlobalHook = globalHooksIterator.next()
		} else {
			yield* codeHookGroup.hooks
			nextCodeHook = codeHooksIterator.next()
		}
	}
}

function getHookName(hook) {
	const callbackName = hook.callback ? (hook.callback.name || '(anonymous)') : '<unknown>',
		namespace = hook.namespace || '<unknown>'
	return `${callbackName} in ${namespace}`
}

function getMessageName(map, identifier, version, originalName) {
	if(typeof identifier === 'string') {
		const append = (identifier !== originalName) ? ` (original: "${originalName}")` : ''
		return `${identifier}<${version}>${append}`
	}

	if(typeof identifier === 'number') {
		const name = map.code.get(identifier) || `(opcode ${identifier})`
		return `${name}<${version}>`
	}

	return '(?)'
}

function parseStack(err) {
	const stack = (err && err.stack) || ''
	return stack.split('\n').slice(1).map((line) => {
		if(line.indexOf('(eval ') !== -1) {
			// throw away eval info
			// see <https://github.com/stacktracejs/error-stack-parser/blob/d9eb56a/error-stack-parser.js#L59>
			line = line.replace(/(\(eval at [^()]*)|(\),.*$)/g, '')
		}

		const match = line.match(/^\s*at (?:.+\s+\()?(?:(.+):\d+:\d+|([^)]+))\)?/)
		return match && {
			filename: match[2] || match[1],
			source: line,
		}
	}).filter(Boolean)
}

function errStack(err = new Error(), removeFront = true) {
	const stack = parseStack(err)
	const libPath = /tera-proxy-game[\\/]lib/

	// remove node internals from end
	while (stack.length > 0 && !path.isAbsolute(stack[stack.length - 1].filename)) {
		stack.pop()
	}

	// remove tera-proxy-game internals from end
	while (stack.length > 0 && libPath.test(stack[stack.length - 1].filename)) {
		stack.pop()
	}

	if(removeFront) {
		// remove tera-proxy-game internals from front
		while (stack.length > 0 && libPath.test(stack[0].filename)) {
			stack.shift()
		}
	}

	return stack.map(frame => frame.source).join('\n')
}

// -----------------------------------------------------------------------------

class Dispatch extends EventEmitter {
	constructor(connection, protocolVersion) {
		super()

		this.connection = connection
		this.modules = new Map()

		// hooks:
		// { <code>:
		//	 [ { <order>
		//		 , hooks:
		//			 [ { <code>, <filter>, <order>, <definitionVersion>, <namespace>, <callback> }
		//			 ]
		//		 }
		//	 ]
		// }
		this.hooks = new Map()

		if(protocolVersion) this.setProtocolVersion(protocolVersion)
	}

	reset() {
		for(const name of this.modules.keys()) {
			this.unload(name)
		}

		this.modules.clear()
		this.hooks.clear()
	}

	load(name, from = module, ...args) {
		const mod = this.modules.get(name)
		if(mod) return mod

		if(typeof from.require !== 'function' && typeof from === 'function')
			from = { require: (ModuleConstructor => () => ModuleConstructor)(from) } // `from` is a function, so use itself the module constructor

		try {
			const ModuleConstructor = from.require(name),
				wrapper = new Wrapper(this, name),
				loadedModule = new ModuleConstructor(wrapper, ...args)
			this.modules.set(name, loadedModule)

			log.info(`[dispatch] loaded "${name}"`)

			return loadedModule
		}
		catch (e) {
			// Remove any hooks that may have been added by the broken mod
			for(const orderings of this.hooks.values())
				for(const ordering of orderings)
					ordering.hooks = ordering.hooks.filter(hook => hook.namespace !== name)

			log.error(`[dispatch] load: error initializing mod "${name}"`)
			console.error(e)
		}

		return null
	}

	unload(name) {
		const mod = this.modules.get(name)

		if(!mod) {
			log.error([
				`[dispatch] unload: cannot unload non-loaded module "${name}"`,
				errStack(),
			].join('\n'))
			return false
		}

		for(const orderings of this.hooks.values())
			for(const ordering of orderings)
				ordering.hooks = ordering.hooks.filter(hook => hook.namespace !== name)

		if(typeof mod.destructor === 'function') {
			try {
				mod.destructor()
			} catch (e) {
				log.error([
					`[dispatch] unload: error running destructor for module "${name}"`,
					`error: ${e.message}`,
					errStack(e),
				].join('\n'))
			}
		}

		this.modules.delete(name)
		return true
	}

	hook(namespace, name, version, opts, cb) {
		// Parse args
		if(typeof version !== 'number' && version !== '*' && version !== 'raw') throw TypeError(`[dispatch] hook: invalid version specified (${version})`)
		if(typeof opts === 'function') {
			cb = opts
			opts = {}
		}
		if(typeof cb !== 'function') throw TypeError(`[dispatch] hook: last argument not a function (given: ${typeof cb})`)

		// Retrieve opcode
		let code
		// Wildcard
		if(name === '*') {
			code = '*'
			if(typeof version === 'number') throw TypeError(`[dispatch] hook: * hook must request version '*' or 'raw' (given: ${version})`)
		}
		// Named packet
		else {
			// Check if opcode is mapped
			code = this.protocolMap.name.get(name)
			if(code == null) throw Error(`[dispatch] hook: unmapped packet "${name}"`)

			// Check if definition exists
			if(version !== 'raw') {
				let def = protocol.messages.get(name)
				if(def) def = def.get(version)
				if(!def)
					if(latestDefVersion.get(name) > version)
						throw Error(`[dispatch] hook: obsolete defintion (${name}.${version})`)
					else throw Error(`[dispatch] hook: definition not found (${name}.${version})`)
			}

			// TODO: Add deprecation
		}

		// Create hook
		const order = opts.order || 0,
			hook = {
				namespace, // TODO: Replace with wrapper ref
				code,
				filter: Object.assign({
					fake: false,
					incoming: null,
					modified: null,
					silenced: false
				}, opts.filter),
				order,
				definitionVersion: version,
				callback: cb,
				timeout: opts.timeout ? setTimeout(() => {
					this.unhook(hook)
					hook.callback(null)
				}, opts.timeout) : null,

				// Callback context
				name
			}

		// Add hook
		if(!this.hooks.has(code)) this.hooks.set(code, [])

		const ordering = this.hooks.get(code),
			index = binarySearch(ordering, { order }, (a, b) => a.order - b.order)

		if(index < 0) ordering.splice(~index, 0, { order, hooks: [hook] })
		else ordering[index].hooks.push(hook)

		return hook
	}

	unhook(hook) {
		if(!hook || !this.hooks.has(hook.code)) return

		const group = this.hooks.get(hook.code).find(o => o.order === hook.order)
		if(group) group.hooks = group.hooks.filter(h => h !== hook)

		if(hook.timeout) clearTimeout(hook.timeout)
	}

	write(outgoing, name, version, data) {
		if(!this.connection) return false

		if(Buffer.isBuffer(name)) data = Buffer.from(name)
		else {
			if(typeof version !== 'number' && typeof version !== 'string') {
				log.error(`[dispatch] write: version is required\n${errStack()}`)
				return false
			}

			if(version !== '*') {
				const latest = latestDefVersion.get(name)
				if(latest && version < latest) {
					log.warn([
						`[dispatch] write: ${getMessageName(this.protocolMap, name, version, name)} is not latest version (${latest})`,
						errStack()
					].join('\n'))
				}
			}

			try {
				data = protocol.write(this.protocolVersion, name, version, data)
			} catch (e) {
				log.error([
					`[dispatch] write: failed to generate ${getMessageName(this.protocolMap, name, version, name)}`,
					`error: ${e.message}`,
					errStack(e, false)
				].join('\n'))
				return false
			}
		}

		data = this.handle(data, !outgoing, true)
		if(data === false) return false

		this.connection[outgoing ? 'sendServer' : 'sendClient'](data)
		return true
	}

	setProtocolVersion(version) {
		this.protocolVersion = version
		this.protocolMap = protocol.maps.get(this.protocolVersion)

		if(revisions[version]) {
			this.setRevision(revisions[version])

			// uncomment if BHS breaks C_LOGIN_ARBITER.patchVersion again
			//this.sysmsgMap = sysmsg.maps.get(this.sysmsgVersion || this.majorPatchVersion + this.minorPatchVersion.toString().padStart(2, '0'))
			this.sysmsgMap = sysmsg.maps.get(this.sysmsgVersion || this.majorPatchVersion)
		}

		if(!this.protocolMap) {
			if(this.protocolVersion !== 0) {
				log.error(`[dispatch] handle: unmapped protocol version ${this.protocolVersion}`)
			}
		} else
			log.info(`[dispatch] switching to protocol version ${this.protocolVersion}`)

		this.emit('init')
	}

	setRevision(rev) {
		// (region-)majorPatchVersion(.minorPatchVersion)(/sysmsgVersion)
		const match = /^((.+?)-)?(\d+)(\.(\d+))?(\/(\d+))?$/.exec(rev)

		if(!match) throw Error(`Invalid revision "${rev}"`)

		this.region = match[2]
		this.majorPatchVersion = Number(match[3])
		this.minorPatchVersion = Number(match[5]) || 0
		this.sysmsgVersion = match[7] ? Number(match[7]) : undefined
	}

	parseSystemMessage(message) {
		if(message[0] !== '@') throw Error(`Invalid system message "${message}" (expected @)`)

		const tokens = message.split('\v'),
			id = tokens[0].substring(1),
			name = id.includes(':') ? id : this.sysmsgMap.code.get(parseInt(id))

		if(!name) throw Error(`Unmapped system message ${id} ("${message}")`)

		const data = {}

		for(let i = 2; i < tokens.length; i += 2) data[tokens[i - 1]] = tokens[i]

		return {id: name, tokens: data}
	}

	buildSystemMessage(message, data) {
		if(typeof message === 'string') message = {id: message, tokens: data}
		else {
			const type = message === null ? 'null' : typeof message

			if(type !== 'object') throw TypeError(`Expected object or string, got ${type}`)
			if(!message.id) throw Error('message.id is required')
		}

		const id = message.id.toString().includes(':') ? message.id : this.sysmsgMap.name.get(message.id)

		if(!id) throw Error(`Unknown system message "${message.id}"`)

		data = message.tokens

		let str = '@' + id

		for(let key in data) str += `\v${key}\v${data[key]}`

		return str
	}

	handle(data, incoming, fake = false) {
		const code = data.readUInt16LE(2)

		if(code === 19900 && !this.protocolVersion) { // C_CHECK_VERSION
			// TODO hack; we should probably find a way to hardcode this, but it'll
			// work for now since this packet should never change (?)
			const ver = protocol.maps.keys().next().value

			try {
				const parsed = protocol.parse(ver, code, 1, data),
					[item] = parsed.version

				if(!item || item.index !== 0) {
					log.error([
						'[dispatch] handle: failed to retrieve protocol version from C_CHECK_VERSION<1> (index != 0)',
						`data: ${data.toString('hex')}`,
						`item: ${JSON.stringify(item)}`,
					].join('\n'))
				} else {
					this.setProtocolVersion(item.value)
				}
			}
			catch(e) {
				log.error([
					'[dispatch] handle: failed to parse C_CHECK_VERSION<1> for dynamic protocol versioning',
					`data: ${data.toString('hex')}`,
					`error: ${e.message}`,
					errStack(e),
				].join('\n'))
			}
		}

		const copy = Buffer.from(data)

		const globalHooks = this.hooks.get('*')
		const codeHooks = this.hooks.get(code)
		if(!globalHooks && !codeHooks) return data

		const { protocolVersion } = this
		let modified = false
		let silenced = false

		function bufferAttachFlags(buf) {
			Object.defineProperties(buf, {
				$fake: { get: () => fake },
				$incoming: { get: () => incoming },
				$modified: { get: () => modified },
				$silenced: { get: () => silenced },
			})
		}

		function objectAttachFlags(obj) {
			Object.defineProperties(obj, {
				$fake: { value: fake },
				$incoming: { value: incoming },
				$modified: { value: modified },
				$silenced: { value: silenced },
			})
		}

		bufferAttachFlags(data)

		let eventCache = [],
			iter = 0,
			hooks = (globalHooks ? globalHooks.size : 0) + (codeHooks ? codeHooks.size : 0)

		for(const hook of iterateHooks(globalHooks, codeHooks)) {
			// check flags
			const { filter } = hook
			if(filter.fake != null && filter.fake !== fake) continue
			if(filter.incoming != null && filter.incoming !== incoming) continue
			if(filter.modified != null && filter.modified !== modified) continue
			if(filter.silenced != null && filter.silenced !== silenced) continue

			const lastHook = ++iter === hooks

			if(hook.definitionVersion === 'raw')
				try {
					const result = hook.callback(code, data, incoming, fake)

					if(Buffer.isBuffer(result) && result !== data) {
						modified = modified || (result.length !== data.length) || !result.equals(data)
						bufferAttachFlags(result)
						data = result
					} else {
						modified = modified || !data.equals(copy)
						if(typeof result === 'boolean') silenced = !result
					}
				}
				catch(e) {
					log.error([
						`[dispatch] handle: error running raw hook for ${getMessageName(this.protocolMap, code, hook.definitionVersion)}`,
						`hook: ${getHookName(hook)}`,
						`data: ${data.toString('hex')}`,
						`error: ${e.message}`,
						errStack(e),
					].join('\n'))
					continue
				}
			else { // normal hook
				try {
					const defVersion = hook.definitionVersion
					
					let event = eventCache[defVersion] || (eventCache[defVersion] = protocol.parse(protocolVersion, code, defVersion, data))

					objectAttachFlags(lastHook ? event : (event = deepClone(event)))

					try {
						const result = hook.callback(event, fake)

						if(result === true) {
							modified = true
							silenced = false

							try {
								data = protocol.write(protocolVersion, code, defVersion, event)
								bufferAttachFlags(data)

								eventCache = []
							} catch (e) {
								log.error([
									`[dispatch] handle: failed to generate ${getMessageName(this.protocolMap, code, defVersion)}`,
									`hook: ${getHookName(hook)}`,
									`error: ${e.message}`,
									errStack(e, false),
								].join('\n'))
							}
						}
						else if(result === false) silenced = true
					}
					catch(e) {
						log.error([
							`[dispatch] handle: error running hook for ${getMessageName(this.protocolMap, code, defVersion)}`,
							`hook: ${getHookName(hook)}`,
							`data: ${util.inspect(event)}`,
							`error: ${e.message}`,
							errStack(e),
						].join('\n'))
					}
				}
				catch(e) {
					log.error([
						`[dispatch] handle: failed to parse ${getMessageName(this.protocolMap, code, hook.definitionVersion)}`,
						`hook: ${getHookName(hook)}`,
						`data: ${data.toString('hex')}`,
						`error: ${e.message}`,
						errStack(e, false),
					].join('\n'))
				}
			}
		}

		// return value
		return (!silenced ? data : false)
	}
}

// Faster than re-parsing a packet
function deepClone(obj) {
	if(obj instanceof Buffer) return Buffer.from(obj)

	for(let t of types) // Custom parser types
		if(obj instanceof t) return Object.assign(Object.create(t.prototype), obj)

	let copy = Array.isArray(obj) ? [] : {}

	for(let key in obj) {
		let val = obj[key]

		if(typeof val === 'object') copy[key] = deepClone(val)
		else copy[key] = val
	}

	return copy
}

module.exports = Dispatch