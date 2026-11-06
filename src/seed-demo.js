require('dotenv').config();
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main(){
  const files = [
    path.join(__dirname,'../database/seed_demo.sql'),
    path.join(__dirname,'../database/seed_stok_audit.sql')
  ];
  for (const file of files) {
    const raw=fs.readFileSync(file,'utf8').replace(/^\s*--.*$/gm,'');
    const sql=raw.split(/;\s*(?:\r?\n|$)/).map(x=>x.trim()).filter(Boolean);
    for(const statement of sql){
      await db.query(statement);
    }
  }
  console.log('Demo data produk, cabang, stok, transaksi, dan riwayat audit berhasil diproses.');
  await db.end();
}
main().catch(async err=>{console.error('Gagal memasukkan demo data:',err.message);try{await db.end()}catch{}process.exit(1)});
