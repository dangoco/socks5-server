#!/usr/bin/env node
'use strict';

var net = require('net'),
	dgram = require('dgram'),
	{
		createServer,
		Address,
		Port,
		UDPRelay,
		replyHead5,
	} = require('./socks.js');
var commander = require('commander');
	
commander
	.usage('[options]')
	.option('-u, --user [value]', 'set a user:pass format user')
	.option('-H, --host [value]', 'host to listen,defaults to 127.0.0.1')
	.option('-P, --port <n>', 'port to listen,defaults to 1080',/^\d+$/i)
	.parse(process.argv);

// Create server
// The server accepts SOCKS connections. This particular server acts as a proxy.
var HOST=commander.host||'127.0.0.1',
	PORT=commander.port||'1080',
	server = createServer();

console.log('server starting at ',HOST,':',PORT);

if(commander.user){
	let u=commander.user.split(":");
	server.setSocks5UserPass(u[0],u[1]);
	console.log('user ',commander.user);
}


/*
tcp request relay
directly connect the target and source
*/
function relayTCP(socket, port, address, CMD_REPLY){
	let proxy = net.createConnection({
		port:port, 
		host:address
	});
	proxy.targetAddress=address;
	proxy.targetPort=port;
	proxy.on('connect',()=>{
		CMD_REPLY(0x00,proxy.localAddress,proxy.localPort);
		console.log('[TCP]',`${socket.remoteAddress}:${socket.remotePort} ==> ${net.isIP(address)?'':'('+address+')'} ${proxy.remoteAddress}:${proxy.remotePort}`);
		proxy.pipe(socket);
		socket.pipe(proxy);
	}).on('error',e=>{
		let rep=0x01;
		if(e.message.indexOf('ECONNREFUSED')>-1){
			rep=0x05;
		}else if(e.message.indexOf('EHOSTUNREACH')>-1){
			rep=0x04;
		}else if(e.message.indexOf('ENETUNREACH')>-1){
			rep=0x03;
		}else if(e.message.indexOf('ENETUNREACH')>-1){
			rep=0x03;
		}
		CMD_REPLY(rep);
		console.error('	[TCP proxy error]',`${proxy.targetAddress}:${proxy.targetPort}`,e.message);
	});

	socket.on('close',e=>{
		proxy.destroy();
		if(socket.connecting)proxy.destroy('Client closed');
		let msg='';
		if(socket.remoteAddress)
			msg+=`${socket.remoteAddress}:${socket.remotePort} ==> `;
		if(proxy.remoteAddress){
			msg+=`${net.isIP(address)?'':'('+address+')'} ${proxy.remoteAddress}:${proxy.remotePort}`;
		}else{
			msg+=`${address}:${port}`;
		}
		console.log('  [TCP closed]',msg);
	});
}

/*
udp request relay
send udp msgs to each other
*/
function relayUDP(socket, port, address, CMD_REPLY){
	console.log('[UDP]',`${socket.remoteAddress}`);
	let relay=new UDPRelay(socket, port, address, CMD_REPLY);

	relay.on('datagram',packet=>{//client to target forward
		relay.relaySocket.send(packet.data,packet.port,packet.address,err=>{
			if(err)server.emit('proxy_error',proxy,'UDP to remote error',err);
		});
	});
	relay.relaySocket.on('message',(msg,info)=>{//target to client forward
		if(!relay.usedClientAddress)return;//ignore if client address is unknown
		if(info.address===relay.usedClientAddress && info.port===relay.usedClientPort)return;//ignore client message
		relay.reply(info.address,info.port,msg,err=>{
			if(err)console.error('	[UDP proxy error]',err.message);
		});
	}).once('close',()=>{
		let msg='';
		if(relay.usedClientAddress)
			msg+=`${relay.usedClientAddress}:${relay.usedClientPort} ==> `;
		msg+=`(${[...relay.reached].join(' , ')||'no target reached'})`
		console.log('  [UDP closed]',msg);
	});
}


//the socks server
server
.on('tcp',relayTCP)
.on('udp',relayUDP)
.on('error', function (e) {
	console.error('SERVER ERROR: %j', e);
	if(e.code == 'EADDRINUSE') {
		console.log('Address in use, retrying in 10 seconds...');
		setTimeout(function () {
			console.log('Reconnecting to %s:%s', HOST, PORT);
			server.close();
			server.listen(PORT, HOST);
		}, 10000);
	}
}).on('client_error',(socket,e)=>{
	console.error('  [client error]',`${net.isIP(socket.targetAddress)?'':'('+socket.targetAddress+')'} ${socket.remoteAddress}:${socket.targetPort}`,e.message);
}).on('socks_error',(socket,e)=>{
	console.error('  [socks error]',`${net.isIP(socket.targetAddress)?'':'('+(socket.targetAddress||"unknown")+')'} ${socket.remoteAddress||"unknown"}}:${socket.targetPort||"unknown"}`,e);
}).once('listening',()=>{
	process.on('uncaughtException',function(e){//prevent client from stoping when uncaughtException occurs
		console.error(e);
	});
}).listen(PORT, HOST);

