const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// Inisialisasi Supabase
const supabaseUrl = process.env.URL;
const supabaseKey = process.env.PUBLIC;
if (!supabaseUrl || !supabaseKey) {
    console.error("ERROR: SUPABASE_URL atau SUPABASE_ANON_KEY belum diatur di Environment Variables!");
}
const supabase = createClient(supabaseUrl, supabaseKey);

const server = http.createServer(async (req, res) => {
    // 1. Header CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        
        // Root path untuk tes akses langsung di browser
        if (parsedUrl.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end('Proxy Railway untuk OtoMax & Supabase Aktif!');
            return;
        }

        if (parsedUrl.pathname === '/transaksi' || parsedUrl.pathname === '/run') {
            const memberID = parsedUrl.searchParams.get('memberID') || '';
            const product = parsedUrl.searchParams.get('product') || '';
            const dest = parsedUrl.searchParams.get('dest') || '';
            const refID = parsedUrl.searchParams.get('refID') || '';
            const sign = parsedUrl.searchParams.get('sign') || '';

            if (!product || !dest || !sign) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: false, message: "Parameter tidak lengkap." }));
                return;
            }

            const targetUrl = `http://49.128.180.101:18000/transaksi?memberID=${encodeURIComponent(memberID)}&product=${encodeURIComponent(product)}&dest=${encodeURIComponent(dest)}&refID=${encodeURIComponent(refID)}&sign=${encodeURIComponent(sign)}`;

            // Gunakan AbortController dengan timeout 8 detik agar tidak menggantung
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            let responseText = "";
            try {
                const response = await fetch(targetUrl, { 
                    method: 'GET',
                    signal: controller.signal 
                });
                clearTimeout(timeoutId);
                responseText = await response.text();
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: false, message: "Gagal terhubung ke server OtoMax (Timeout/Koneksi terputus): " + fetchErr.message }));
                return;
            }

            // Simpan ke Supabase PostgreSQL (Jalankan di background agar tidak memblokir respons)
            if (supabaseUrl && supabaseKey) {
                supabase
                    .from('inbox_direct_transaksi')
                    .insert([
                        { 
                            kode_transaksi: refID, 
                            tujuan: dest, 
                            pesan: responseText, 
                            tgl_entri: new Date().toISOString() 
                        }
                    ])
                    .then(({ error }) => {
                        if (error) console.error("Gagal simpan Supabase:", error.message);
                    })
                    .catch(dbErr => console.error("DB Error:", dbErr.message));
            }

            // Kirim respons balik ke frontend
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end(responseText);
            return;
        }

        // Jika path tidak ditemukan
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: false, message: "Endpoint tidak ditemukan." }));

    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: false, message: "Server Error: " + err.message }));
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
