(async()=>{
const me=await boot('Pegawai','pegawai.html',`
<div class="page-head">
  <div>
    <div class="eyebrow">MANAJEMEN AKUN</div>
    <h1>Pegawai & Akun</h1>
    <p>Kelola akun pegawai dari satu tempat. Gunakan filter cabang dan peran untuk menemukan akun dengan cepat.</p>
  </div>
  <div class="actions">
    <button class="btn secondary" id="printAll">⎙ Cetak Pegawai</button>
    <button class="btn primary" id="add">＋ Tambah Pegawai</button>
  </div>
</div>

<div class="employee-filters panel">
  <div class="filter-grid">
    <label class="filter-field"><span>Cabang</span><select id="branchFilter"><option value="all">Semua Cabang</option></select></label>
    <label class="filter-field"><span>Peran / Akun</span><select id="roleFilter">
      <option value="all">Semua Akun</option>
      <option value="bos">Bos</option>
      <option value="admin_pusat">Admin Pusat</option>
      <option value="admin_cabang">Admin Cabang</option>
      <option value="pegawai">Pegawai</option>
    </select></label>
    <label class="filter-field"><span>Kelompok</span><select id="archiveFilter"><option value="active">Pegawai aktif & nonaktif</option><option value="archived">Arsip</option><option value="all">Semua</option></select></label>
    <label class="filter-field filter-search"><span>Cari</span><input id="q" class="search" placeholder="Cari ID, nama, role, atau cabang..."></label>
    <button class="btn secondary filter-reset" id="resetFilters">Reset Filter</button>
  </div>
  <div class="filter-hint" id="filterHint"></div>
</div>

<div class="panel employee-panel">
  <div class="panel-head stock-table-head">
    <div><b>Daftar Pegawai & Akun</b><small id="tableDescription">Semua akun yang tersimpan di sistem.</small></div>
    <span class="result-count" id="count">0 akun</span>
  </div>
  <div class="table-wrap">
    <table class="table employee-table">
      <thead><tr><th>Akun</th><th>Nama</th><th>Peran</th><th>Cabang</th><th>Status</th><th>Aksi</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
  </div>
</div>`);

let data=(await api('/api/users')).users;
let branches=[];
try{branches=(await api('/api/branches')).branches}catch{}

const roleLabel={bos:'Bos',admin_pusat:'Admin Pusat',admin_cabang:'Admin Cabang',pegawai:'Pegawai'};
function fillBranches(){
  $('#branchFilter').innerHTML='<option value="all">Semua Cabang</option>'+branches.map(b=>`<option value="${b.id}">${esc(b.name)} — ${esc(b.code)}</option>`).join('');
}
fillBranches();

function filtered(){
  const q=$('#q').value.trim().toLowerCase();
  const branch=$('#branchFilter').value;
  const role=$('#roleFilter').value;
  const archive=$('#archiveFilter').value;
  return data.filter(x=>{
    if(archive==='active' && x.archived_at) return false;
    if(archive==='archived' && !x.archived_at) return false;
    const text=`${x.username} ${x.full_name} ${x.role} ${x.branch_name||'Pusat'}`.toLowerCase();
    const matchesQ=!q||text.includes(q);
    const matchesRole=role==='all'||x.role===role;
    const matchesBranch=branch==='all'||Number(x.branch_id)===Number(branch);
    return matchesQ&&matchesRole&&matchesBranch;
  });
}

function render(){
  const branch=$('#branchFilter').value;
  const role=$('#roleFilter').value;
  const list=filtered();
  $('#count').textContent=`${list.length} akun`;
  $('#filterHint').textContent=branch==='all'
    ? 'Menampilkan akun dari seluruh cabang.'
    : `Cabang dipilih: ${branches.find(b=>Number(b.id)===Number(branch))?.name||'Cabang'}. Pada filter cabang, yang tampil adalah Admin Cabang dan Pegawai dari cabang tersebut.`;
  $('#tableDescription').textContent=branch==='all'?'Semua akun yang tersimpan di sistem.':`Akun pada ${branches.find(b=>Number(b.id)===Number(branch))?.name||'cabang terpilih'}.`;
  $('#rows').innerHTML=list.map(x=>{
    const initials=(x.full_name||x.username||'U').split(/\s+/).slice(0,2).map(v=>v[0]).join('').toUpperCase();
    const branchText=x.branch_name||'Pusat';
    return `<tr>
      <td><div class="employee-account"><div class="employee-avatar">${x.photo?`<img src="${esc(x.photo)}" alt="Foto ${esc(x.full_name)}">`:esc(initials)}</div><div><b>${esc(x.username)}</b><small>ID ${x.id}</small></div></div></td>
      <td><div class="employee-name"><b>${esc(x.full_name)}</b></div></td>
      <td><span class="badge info role-badge">${esc(roleLabel[x.role]||x.role)}</span></td>
      <td>${esc(branchText)}</td>
      <td><span class="badge ${x.archived_at?'warning':(x.status==='aktif'?'ok':'danger')}">${x.archived_at?'Diarsipkan':(x.status==='aktif'?'Aktif':'Nonaktif')}</span></td>
      <td><div class="row-actions">${x.role==='bos'?'Akun Bos dilindungi':`
        <button class="btn secondary btn-small edit" data-id="${x.id}">Edit</button>
        <button class="btn secondary btn-small reset" data-id="${x.id}">Reset Password</button>
        ${x.archived_at
          ? `<button class="btn secondary btn-small restore" data-id="${x.id}">Pulihkan</button>`
          : `<button class="btn secondary btn-small toggle-status" data-id="${x.id}">${x.status==='aktif'?'Nonaktifkan':'Aktifkan'}</button><button class="btn secondary btn-small archive" data-id="${x.id}">Arsipkan</button>`}
        <button class="btn danger btn-small delete-user" data-id="${x.id}">Hapus</button>`}
      </div></td>
    </tr>`;
  }).join('')||'<tr><td colspan="6" class="empty"><b>Tidak ada akun ditemukan</b><span>Coba ubah filter cabang, peran, atau kata pencarian.</span></td></tr>';
  document.querySelectorAll('.edit').forEach(b=>b.onclick=()=>form(data.find(x=>x.id==b.dataset.id)));
  document.querySelectorAll('.reset').forEach(b=>b.onclick=()=>reset(data.find(x=>x.id==b.dataset.id)));
  document.querySelectorAll('.toggle-status').forEach(b=>b.onclick=()=>toggleStatus(data.find(x=>x.id==b.dataset.id)));
  document.querySelectorAll('.archive').forEach(b=>b.onclick=()=>archiveUser(data.find(x=>x.id==b.dataset.id),true));
  document.querySelectorAll('.restore').forEach(b=>b.onclick=()=>archiveUser(data.find(x=>x.id==b.dataset.id),false));
  document.querySelectorAll('.delete-user').forEach(b=>b.onclick=()=>deleteUser(data.find(x=>x.id==b.dataset.id)));
}

$('#q').oninput=render;
$('#branchFilter').onchange=render;
$('#roleFilter').onchange=render;
$('#archiveFilter').onchange=render;
$('#resetFilters').onclick=()=>{$('#q').value='';$('#branchFilter').value='all';$('#roleFilter').value='all';$('#archiveFilter').value='active';render()};
$('#add').onclick=()=>form();
$('#printAll').onclick=()=>printEmployees(filtered());
render();

function printEmployees(list){
  const w=window.open('','_blank','width=1000,height=760');
  if(!w){toast('Popup diblokir browser.','warning');return}
  const rows=list.map(x=>`<tr><td>${x.photo?`<img src="${esc(x.photo)}" style="width:38px;height:38px;object-fit:cover;border-radius:50%">`:esc((x.full_name||'U').charAt(0))}</td><td>${esc(x.username)}</td><td>${esc(x.full_name)}</td><td>${esc(roleLabel[x.role]||x.role)}</td><td>${esc(x.branch_name||'Pusat')}</td><td>${esc(x.status==='aktif'?'Aktif':'Nonaktif')}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>Daftar Pegawai FACETHEHTIC</title><style>body{font:12px Arial;padding:28px;color:#2b2028}h1{font:24px Georgia;margin:0 0 5px}p{color:#777}.meta{display:flex;gap:18px;margin:12px 0;color:#555}table{width:100%;border-collapse:collapse;margin-top:18px}th,td{padding:9px;border:1px solid #ddd;text-align:left;vertical-align:middle}th{background:#f4ece8}img{display:block}</style></head><body><h1>FACETHEHTIC — Daftar Pegawai & Akun</h1><p>Dicetak dari sistem kasir internal.</p><div class="meta"><span>Total: <b>${list.length}</b> akun</span><span>Tanggal: <b>${new Date().toLocaleString('id-ID')}</b></span></div><table><thead><tr><th>Foto</th><th>Username</th><th>Nama</th><th>Peran</th><th>Cabang</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table><script>window.onload=()=>window.print()</script></body></html>`);w.document.close();
}

function form(item){
  const m=document.createElement('div');m.className='modal-back';
  m.innerHTML=`<div class="modal modal-wide"><div class="panel-head"><div><b>${item?'Edit':'Tambah'} Akun</b><small>Atur data akun, cabang, status, dan foto pegawai.</small></div><button class="btn secondary" id="x">Tutup</button></div><div class="panel-body"><form id="f" class="form-grid employee-form"><label>Username<input name="username" required value="${esc(item?.username||'')}"></label><label>Nama Lengkap<input name="full_name" required value="${esc(item?.full_name||'')}"></label><label>Password ${item?'(kosongkan jika tidak diubah)':''}<input name="password" type="password" ${item?'':'required'}></label><label>Role<select name="role"><option value="admin_pusat" ${item?.role==='admin_pusat'?'selected':''}>Admin Pusat</option><option value="admin_cabang" ${item?.role==='admin_cabang'?'selected':''}>Admin Cabang</option><option value="pegawai" ${item?.role==='pegawai'?'selected':''}>Pegawai</option></select></label><label>Cabang<select name="branch_id"><option value="">Pusat</option>${branches.map(b=>`<option value="${b.id}" ${item?.branch_id==b.id?'selected':''}>${esc(b.name)} — ${esc(b.code)}</option>`).join('')}</select></label><label>Status<select name="status"><option value="aktif" ${!item||item.status==='aktif'?'selected':''}>Aktif</option><option value="nonaktif" ${item?.status==='nonaktif'?'selected':''}>Nonaktif</option></select></label><label style="grid-column:1/-1">Foto Pegawai<div class="employee-photo-input"><div class="employee-form-preview" id="employeePhotoPreview">${item?.photo?`<img src="${esc(item.photo)}" alt="">`:`<span>${esc((item?.full_name||'P').charAt(0))}</span>`}</div><div><input id="photo" type="file" accept="image/png,image/jpeg,image/webp"><small class="helper">Maksimal 1 MB. Gunakan foto portrait. Sistem menampilkan foto dalam area tetap agar tabel tidak melebar.</small></div></div></label><div class="form-actions" style="grid-column:1/-1"><button type="button" class="btn secondary" id="cancel">Batal</button><button class="btn primary">Simpan</button></div></form></div></div>`;
  document.body.appendChild(m);let photo=item?.photo||'';
  $('#x').onclick=$('#cancel').onclick=()=>m.remove();
  $('#photo').onchange=e=>{const file=e.target.files?.[0];if(!file)return;if(file.size>1024*1024){toast('Foto maksimal 1 MB.','error');e.target.value='';return;}const r=new FileReader();r.onload=()=>{photo=r.result;$('#employeePhotoPreview').innerHTML=`<img src="${esc(photo)}" alt="">`};r.readAsDataURL(file)};
  $('#f').onsubmit=async e=>{e.preventDefault();const p=Object.fromEntries(new FormData(e.target));p.branch_id=p.branch_id?Number(p.branch_id):null;p.photo=photo;try{await api(item?'/api/users/'+item.id:'/api/users',{method:item?'PUT':'POST',body:JSON.stringify(p)});m.remove();data=(await api('/api/users')).users;render();toast('Akun tersimpan.','success')}catch(x){toast(x.message,'error')}};
}

async function refreshUsers(){
  data=(await api('/api/users')).users;
  render();
}
async function toggleStatus(item){
  if(!item)return;
  const next=item.status==='aktif'?'nonaktif':'aktif';
  if(!confirm(`${next==='nonaktif'?'Nonaktifkan':'Aktifkan'} akun ${item.full_name}?`))return;
  try{
    await api('/api/users/'+item.id,{method:'PUT',body:JSON.stringify({
      username:item.username,full_name:item.full_name,role:item.role,
      branch_id:item.branch_id,status:next,photo:item.photo
    })});
    await refreshUsers();
    toast(`Akun berhasil ${next==='aktif'?'diaktifkan':'dinonaktifkan'}.`,'success');
  }catch(e){toast(e.message,'error')}
}
async function archiveUser(item, archived){
  if(!item)return;
  const action=archived?'mengarsipkan':'memulihkan';
  if(!confirm(`Yakin ingin ${action} akun ${item.full_name}?`))return;
  try{
    await api(`/api/users/${item.id}/archive`,{method:'POST',body:JSON.stringify({archived})});
    await refreshUsers();
    toast(`Akun berhasil ${archived?'diarsipkan':'dipulihkan'}.`,'success');
  }catch(e){toast(e.message,'error')}
}
async function deleteUser(item){
  if(!item)return;
  if(!confirm(`Hapus permanen akun ${item.full_name}? Penghapusan hanya berhasil jika akun belum memiliki transaksi.`))return;
  try{
    await api('/api/users/'+item.id,{method:'DELETE'});
    await refreshUsers();
    toast('Akun berhasil dihapus.','success');
  }catch(e){toast(e.message,'error')}
}

function reset(item){
  const m=document.createElement('div');m.className='modal-back';m.innerHTML=`<div class="modal"><div class="panel-head"><b>Reset Password</b><button class="btn secondary" id="x">Tutup</button></div><div class="panel-body"><p>Atur password baru untuk <b>${esc(item.full_name)}</b>.</p><form id="f"><label>Password Baru<input name="password" type="password" minlength="6" required></label><div class="form-actions"><button class="btn primary">Simpan Password</button></div></form></div></div>`;document.body.appendChild(m);$('#x').onclick=()=>m.remove();$('#f').onsubmit=async e=>{e.preventDefault();try{await api('/api/users/'+item.id,{method:'PUT',body:JSON.stringify({username:item.username,full_name:item.full_name,role:item.role,branch_id:item.branch_id,status:item.status,photo:item.photo,password:new FormData(e.target).get('password')})});m.remove();toast('Password berhasil direset.','success')}catch(x){toast(x.message,'error')}};
}
})().catch(e=>toast(e.message));
