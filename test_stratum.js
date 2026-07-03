const net = require('net');

const client = new net.Socket();
client.connect(3956, 'ap.luckpool.net', () => {
    console.log('Connected');
    client.write(JSON.stringify({
        id: 1,
        method: 'mining.subscribe',
        params: ['PocketMiner/1.0', null, 'ap.luckpool.net', '3956']
    }) + '\n');
});

client.on('data', (data) => {
    console.log('Received: ' + data.toString());
    client.write(JSON.stringify({
        id: 2,
        method: 'mining.authorize',
        params: ['RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ.worker', 'x']
    }) + '\n');
});

client.on('close', () => console.log('Connection closed'));
client.on('error', (err) => console.log('Error: ' + err.message));

setTimeout(() => { client.destroy(); }, 5000);
