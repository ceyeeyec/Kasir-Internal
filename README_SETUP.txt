FACETHEHTIC KASIR PORTAL - PROFESSIONAL FINAL

1. Extract directly to D:\FACETHEHTIC_KASIR_PORTAL
2. Ensure MySQL/XAMPP is running.
3. For a fresh database, import database/schema.sql in phpMyAdmin.
4. For an existing database, run npm install then npm run seed-demo if needed.
5. Run npm install
6. Run npm start
7. Open http://localhost:3000

DEMO ACCOUNTS
bos / password
adminpusat / password
admincabang1 / password
pegawai1 / password

ROLE NOTES
- Bos: view-only for business data, may edit existing branch information, and may add/edit employee accounts. No business transaction menu.
- Admin Pusat: operational management across all branches, including product master and stock adjustments for every branch.
- Admin Cabang: operational management limited to its own branch; stock edits are restricted server-side to its branch.
- Pegawai: cashier-focused access.

SETTINGS
- Bos can edit store identity, logo, language, theme, and the Bos profile.
- Employee photos and Bos profile photos accept PNG/JPG/WEBP up to 1 MB and are stored in MySQL.
- Logo is stored as a database setting and displayed throughout the portal.
