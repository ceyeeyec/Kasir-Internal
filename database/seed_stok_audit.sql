-- Data contoh khusus audit stok FACETHEHTIC.
-- Aman dijalankan berulang: hanya menambahkan riwayat demo yang belum ada.
-- Tidak mengubah saldo stok yang sudah ada.
USE `facethethic_kasir_db`;

-- Contoh stok masuk dan keluar di setiap cabang. Nilai before/after disusun
-- agar dua contoh per cabang berakhir pada saldo stok aktual yang ada saat seed dijalankan.
INSERT INTO stock_histories(branch_id,product_id,user_id,type,quantity,before_stock,after_stock,note,created_at)
SELECT b.id, p.id, u.id, 'in', 10, GREATEST(bs.stock - 7, 0), bs.stock + 3,
       CASE WHEN b.code = 'MDN' THEN 'DEMO AUDIT: penerimaan 10 unit dari supplier untuk gudang pusat'
            ELSE CONCAT('DEMO AUDIT: penerimaan 10 unit dari gudang pusat ke ', b.name) END,
       DATE_SUB(NOW(), INTERVAL 2 DAY)
FROM branches b
JOIN branch_stocks bs ON bs.branch_id = b.id
JOIN products p ON p.id = bs.product_id AND p.sku = 'P004'
JOIN users u ON u.username = CASE WHEN b.code = 'MDN' THEN 'adminpusat'
                                 WHEN b.code = 'CBG01' THEN 'admincabang1'
                                 WHEN b.code = 'CBG02' THEN 'admincabang2'
                                 WHEN b.code = 'CBG03' THEN 'admincabang3'
                                 ELSE 'admincabang4' END
WHERE NOT EXISTS (
  SELECT 1 FROM stock_histories h
  WHERE h.branch_id = b.id AND h.product_id = p.id
    AND h.type = 'in' AND h.note = CASE WHEN b.code = 'MDN' THEN 'DEMO AUDIT: penerimaan 10 unit dari supplier untuk gudang pusat'
                                        ELSE CONCAT('DEMO AUDIT: penerimaan 10 unit dari gudang pusat ke ', b.name) END
);

INSERT INTO stock_histories(branch_id,product_id,user_id,type,quantity,before_stock,after_stock,note,created_at)
SELECT b.id, p.id, u.id, 'out', 3, bs.stock + 3, bs.stock,
       CASE WHEN b.code = 'MDN' THEN 'DEMO AUDIT: pengeluaran 3 unit untuk kebutuhan operasional pusat'
            ELSE CONCAT('DEMO AUDIT: pengeluaran 3 unit untuk penjualan/operasional ', b.name) END,
       DATE_SUB(NOW(), INTERVAL 1 DAY)
FROM branches b
JOIN branch_stocks bs ON bs.branch_id = b.id
JOIN products p ON p.id = bs.product_id AND p.sku = 'P004'
JOIN users u ON u.username = CASE WHEN b.code = 'MDN' THEN 'adminpusat'
                                 WHEN b.code = 'CBG01' THEN 'admincabang1'
                                 WHEN b.code = 'CBG02' THEN 'admincabang2'
                                 WHEN b.code = 'CBG03' THEN 'admincabang3'
                                 ELSE 'admincabang4' END
WHERE NOT EXISTS (
  SELECT 1 FROM stock_histories h
  WHERE h.branch_id = b.id AND h.product_id = p.id
    AND h.type = 'out' AND h.note = CASE WHEN b.code = 'MDN' THEN 'DEMO AUDIT: pengeluaran 3 unit untuk kebutuhan operasional pusat'
                                         ELSE CONCAT('DEMO AUDIT: pengeluaran 3 unit untuk penjualan/operasional ', b.name) END
);

-- Contoh penyesuaian hasil stok opname di Cabang 1.
INSERT INTO stock_histories(branch_id,product_id,user_id,type,quantity,before_stock,after_stock,note,created_at)
SELECT b.id, p.id, u.id, 'adjust', 2, bs.stock + 2, bs.stock,
       'DEMO AUDIT: penyesuaian hasil stok opname, selisih fisik 2 unit', NOW()
FROM branches b
JOIN branch_stocks bs ON bs.branch_id = b.id
JOIN products p ON p.id = bs.product_id AND p.sku = 'P005'
JOIN users u ON u.username = 'admincabang1'
WHERE b.code = 'CBG01'
AND NOT EXISTS (
  SELECT 1 FROM stock_histories h
  WHERE h.branch_id = b.id AND h.product_id = p.id
    AND h.type = 'adjust'
    AND h.note = 'DEMO AUDIT: penyesuaian hasil stok opname, selisih fisik 2 unit'
);
