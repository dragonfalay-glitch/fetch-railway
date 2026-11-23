const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// Menggunakan nama environment variable yang benar sesuai standar Railway
const supabaseUrl = process.env.URL;
const supabaseKey = process.env.PUBLIC;
const supabase = createClient(supabaseUrl || '', supabaseKey || '');

const server = http.createServer(async (req, res) => {
    // 1. Header CORS diperbarui mendukung POST dan OPTIONS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try {
        const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
        
        if (parsedUrl.pathname === '/') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end('Proxy Railway Aktif!');
            return;
        }

        // 2. Tangani Request POST dari Frontend
        if (req.method === 'POST' && (parsedUrl.pathname === '/transaksi' || parsedUrl.pathname === '/run')) {
            let body = '';
            
            req.on('data', chunk => {
                body += chunk.toString();
            });

            req.on('end', async () => {
                try {
                    const data = JSON.parse(body);
                    const memberID = data.memberID || '';
                    const product = data.product || '';
                    const dest = data.dest || '';
                    const refID = data.refID || '';
                    const sign = data.sign || '';
                    const token = data.token || '';
                    const userID = data.userID || 0;

                    // Target URL ke OtoMax
                    const targetUrl = `http://49.128.180.101:18000/transaksi?memberID=${encodeURIComponent(memberID)}&product=${encodeURIComponent(product)}&dest=${encodeURIComponent(dest)}&refID=${encodeURIComponent(refID)}&sign=${encodeURIComponent(sign)}&token=${encodeURIComponent(token)}`;

                    // ✅ UBAH MENJADI SEPERTI INI (Hanya mencatat RefID atau status penting saja)
                  console.log(`Memproses....`);

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);

                    let responseText = "";
                    try {
                        const response = await fetch(targetUrl, { signal: controller.signal });
                        clearTimeout(timeoutId);
                        responseText = await response.text();
                    } catch (fetchErr) {
                        clearTimeout(timeoutId);
                        console.error("Gagal fetch ke OtoMax:", fetchErr.message);
                        res.writeHead(504, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end(`GAGAL_OTOMAX: Tidak dapat terhubung ke server OtoMax (${fetchErr.message})`);
                        return;
                    }

                    // Simpan ke Supabase di background
                    if (supabaseUrl && supabaseKey) {
                        supabase
                            .from('inbox_direct_transaksi')
                            .insert([{ kode_transaksi: refID, tujuan: dest, pesan: responseText, tgl_entri: new Date().toISOString(), user_id:userID }])
                            .then(({ error }) => { if (error) console.error("Supabase Error:", error.message); })
                            .catch(dbErr => console.error("DB Error:", dbErr.message));
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end(responseText);

                } catch (parseErr) {
                    res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('Format JSON tidak valid.');
                }
            });
            return;
        }
        // Endpoint ambil riwayat transaksi dari Supabase
        if (req.method === 'GET' && parsedUrl.pathname === '/riwayat') {
            if (!supabaseUrl || !supabaseKey) {
                res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
                res.end(JSON.stringify({ status: false, message: 'Konfigurasi Supabase belum lengkap.' }));
                return;
            }

            const refID = parsedUrl.searchParams.get('refID') || '';
            const userID = parsedUrl.searchParams.get('userID') || 2;
            const limitParam = parseInt(parsedUrl.searchParams.get('limit') || '20', 10);
            const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;

            let query = supabase
                .from('inbox_direct_transaksi')
                .select('id, kode_transaksi, tujuan, pesan, tgl_entri, user_id')
                .order('tgl_entri', { ascending: false })
                .limit(limit);

            if (userID) {
                query = query.eq('user_id', userID);
            }

            const { data, error } = await query;

            if (error) {
                console.error("Supabase Select Error:", error.message);
                res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8' });
                res.end(JSON.stringify({ status: false, message: 'Gagal mengambil riwayat dari Supabase.' }));
                return;
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({
                status: true,
                data: data || []
            }));
            return;
        }

        res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('Endpoint tidak ditemukan.');

    } catch (err) {
        console.error("Server Error:", err.message);
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('Server Error: ' + err.message);
    }
});

// Cek IP publik keluar
fetch('https://api.ipify.org?format=json')
    .then(res => res.json())
    .then(data => console.log("IP Publik Railway saat keluar:", data.ip))
    .catch(err => console.error("Gagal cek IP:", err.message));

const PORT = process.env.PORT || 3000;
// Tambahkan '0.0.0.0' agar server dapat diakses publik via Railway dengan stabil
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server berjalan di port ${PORT}`);
});
