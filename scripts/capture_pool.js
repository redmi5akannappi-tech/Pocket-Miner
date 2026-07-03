// Read-only LuckPool protocol capture: subscribe + authorize, then log the
// first mining.set_target and mining.notify with FULL param layout. No shares.
const net = require('net');

const HOST = 'ap.luckpool.net';
const PORT = 3956;
const WALLET = 'RS3cJERG58N2GJbZSP3MpkFunACZ4kawpZ';

const s = net.connect(PORT, HOST, () => {
  console.log(`connected ${HOST}:${PORT}`);
  s.write(JSON.stringify({ id: 1, method: 'mining.subscribe',
    params: ['PocketMiner/1.0', null, HOST, String(PORT)] }) + '\n');
});

let buf = '';
let notifyCount = 0;
s.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  const lines = buf.split('\n');
  buf = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { console.log('RAW:', line); continue; }

    if (m.id === 1) {
      console.log('SUBSCRIBE RESULT:', JSON.stringify(m.result));
      const en1 = m.result && m.result[1];
      console.log(`  extranonce1=${en1}  (${en1 ? en1.length/2 : '?'} bytes) -> nonce2=${en1 ? 32 - en1.length/2 : '?'} bytes`);
      s.write(JSON.stringify({ id: 2, method: 'mining.authorize',
        params: [`${WALLET}.capture`, 'x'] }) + '\n');
      continue;
    }
    if (m.id === 2) { console.log('AUTHORIZE RESULT:', JSON.stringify(m.result), m.error || ''); continue; }

    if (m.method === 'mining.set_target') {
      console.log('SET_TARGET:', JSON.stringify(m.params));
      continue;
    }
    if (m.method === 'mining.notify') {
      notifyCount++;
      const p = m.params || [];
      console.log(`\nNOTIFY #${notifyCount}  (${p.length} params):`);
      const names = ['jobId','version','prevhash','merkleroot','finalsaplingroot','time','bits','cleanjobs','soln_template','p9','p10','p11'];
      p.forEach((v, i) => {
        const label = names[i] || `p${i}`;
        if (typeof v === 'string') {
          console.log(`  [${i}] ${label} len=${v.length} (${v.length/2}B): ${v.length > 80 ? v.slice(0,64)+'…'+v.slice(-16) : v}`);
        } else {
          console.log(`  [${i}] ${label}: ${JSON.stringify(v)}`);
        }
      });
      console.log(`  FULL soln_template[8]: ${p[8]}`);
      console.log(`  FULL time[5]=${p[5]} version[1]=${p[1]} bits[6]=${p[6]}`);
      // Decode solution template header if present
      const tmpl = p[8];
      if (typeof tmpl === 'string' && tmpl.length >= 8) {
        const verLE = tmpl.slice(0,8);
        const ver = parseInt(verLE.match(/../g).reverse().join(''), 16);
        console.log(`  soln_template: first4LE=${verLE} -> version=${ver}  templateBytes=${tmpl.length/2}`);
      }
      if (notifyCount >= 2) { console.log('\ndone.'); s.destroy(); process.exit(0); }
    }
  }
});

s.on('error', (e) => { console.log('ERR', e.message); process.exit(1); });
s.on('close', () => { console.log('closed'); process.exit(0); });
setTimeout(() => { console.log('timeout'); s.destroy(); process.exit(0); }, 30000);
