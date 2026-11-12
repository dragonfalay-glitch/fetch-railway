const http = require('http');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.URL;
const supabaseKey = process.env.PUBLIC;
const supabase = createClient(supabaseUrl || '', supabaseKey || '');

const server = http.createServer(async (req, res) => {
    // 1. Tambahkan Header CORS yang lengkap untuk semua origin
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // 2. Tangani preflight request (OPTIONS) dari browser sebelum request asli masuk
    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        
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

            const targetUrl = `http://49.128.180.101:18000/transaksi?memberID=${encodeURIComponent(memberID)}&product=${encodeURIComponent(product)}&dest=${encodeURIComponent(dest)}&refID=${encodeURIComponent(refID)}&sign=${encodeURIComponent(sign)}`;

            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 8000);

            let responseText = "";
            try {
                const response = await fetch(targetUrl, { signal: controller.signal });
                clearTimeout(timeoutId);
                responseText = await response.text();
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                res.writeHead(504, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: false, message: "Timeout/Gagal ke OtoMax: " + fetchErr.message }));
                return;
            }

            // Simpan ke Supabase di background
            if (supabaseUrl && supabaseKey) {
                supabase
                    .from('inbox_direct_transaksi')
                    .insert([{ kode_transaksi: refID, tujuan: dest, pesan: responseText, tgl_entri: new Date().toISOString() }])
                    .then(({ error }) => { if (error) console.error("Supabase Error:", error.message); })
                    .catch(dbErr => console.error("DB Error:", dbErr.message));
            }

            res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end(responseText);
            return;
        }

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
