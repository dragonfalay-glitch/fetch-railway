const http = require('http');
const { createClient } = require('@supabase/supabase-js');

// Inisialisasi Supabase menggunakan Environment Variables
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY; // atau Service Role Key
const supabase = createClient(supabaseUrl, supabaseKey);

const server = http.createServer(async (req, res) => {
    // Header CORS agar InfinityFree diizinkan mengakses Railway
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host}`);
    
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

        // URL Target Server OtoMax
        const targetUrl = `http://49.128.180.101:18000/transaksi?memberID=${encodeURIComponent(memberID)}&product=${encodeURIComponent(product)}&dest=${encodeURIComponent(dest)}&refID=${encodeURIComponent(refID)}&sign=${encodeURIComponent(sign)}`;

        try {
            // Eksekusi cURL / fetch ke server OtoMax dengan timeout 10 detik
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 10000);

            const response = await fetch(targetUrl, { 
                method: 'GET',
                signal: controller.signal 
            });
            clearTimeout(timeoutId);

            const responseText = await response.text();

            if (!response.ok && !responseText) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ status: false, message: "Gagal terhubung ke server transaksi luar." }));
                return;
            }

            // Simpan ke Supabase PostgreSQL
            try {
                const tglEntri = new Date().toISOString(); // Format ISO untuk PostgreSQL
                
                const { error } = await supabase
                    .from('inbox_direct_transaksi')
                    .insert([
                        { 
                            kode_transaksi: refID, 
                            tujuan: dest, 
                            pesan: responseText, 
                            tgl_entri: tglEntri 
                        }
                    ]);

                if (error) {
                    console.error("Gagal menyimpan ke Supabase:", error.message);
                }
            } catch (dbError) {
                console.error("Error database Supabase:", dbError.message);
            }

            // Teruskan respons mentah dari OtoMax ke frontend InfinityFree
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end(responseText);

        } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: false, message: "Gagal terhubung ke server transaksi luar: " + error.message }));
        }
    } else {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('Railway Proxy Supabase Aktif!');
    }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server berjalan di port ${PORT}`);
});
