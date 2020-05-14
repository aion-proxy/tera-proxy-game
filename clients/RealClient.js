// TODO ? Cleanup XD

const AionCrypto = require('aion-crypto'),
	  Packetizer = require('../packetizer'),
	  decryptor = new AionCrypto(),
	  encryptor = new AionCrypto();

class RealClient {
	constructor(connection, socket) {
		this.connection = connection
		this.socket = socket

		this.session = null
		this.packetizer = new Packetizer(data => {
			//if(this.connection.dispatch) data = this.connection.dispatch.handle(data, false)
			if(data)
				// Note: socket.write() is not thread-safe
				//this.connection.sendServer(data.buffer === this.packetizer.buffer.buffer ? Buffer.from(data) : data)
				//this.connection.sendServer(data)
				this.connection.decryptClient(data)
		})

		socket.on('data', (data) => {
			//console.log('[C] '+data.toString('hex'))
			this.connection.sendServer(data)
			this.packetizer.recv(data)
			/*if(!this.connection) return
			switch (this.connection.state) {
				case 0: {

					if(data.length === 128) {
						this.connection.setClientKey(data)
					}
					break
				}

				case 1: {
					if(data.length === 128) {
						this.connection.setClientKey(data)
					}
					break
				}

				case 2: {
					decryptor.decryptClient(data)
					//this.session.decrypt(data)
					this.packetizer.recv(data)
					break
				}

				default: {
					// ???
					break
				}
			}
			*/
		})

		socket.on('close', () => {
			this.socket = null
			this.close()
		})
	}

	onConnect() {
	}

	onData(data) {
	this.socket.write(data)
	/*
		if(!this.connection) return
		if(this.connection.state === 2) {
			if(!this.session) {
				this.session = this.connection.session.cloneKeys()
			} else {
				this.session.encrypt(data)
			}
		}
		this.socket.write(data)
	*/
	}

	close() {
		if(this.socket) {
			this.socket.end()
			this.socket.unref()
			this.socket = null
		}

		const { connection } = this
		if(connection) {
			this.connection = null // prevent infinite recursion
			connection.close()
		}

		this.session = null
		this.packetizer = null
	}
}

module.exports = RealClient