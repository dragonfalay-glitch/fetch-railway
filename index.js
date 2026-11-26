const http = require('http');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');

// Menggunakan nama environment variable yang benar sesuai standar Railway
const supabaseUrl = process.env.URL;
const supabaseKey = process.env.PUBLIC;
const supabase = createClient(supabaseUrl || '', supabaseKey || '');

// Admin sesi (pastikan ADMIN_USER, ADMIN_PASS, dan ADMIN_SECRET terisi di Railway)
const ADMIN_USER = process.env.ADMIN_USER || '';
const ADMIN_PASS = process.env.ADMIN_PASS || '';
const ADMIN_SECRET = process.env.ADMIN_SECRET || '';

function buatAdminToken(username) {
    const payload = Buffer.from(JSON.stringify({
        user: username,
        exp: Date.now() + 24 * 60 * 60 * 1000
    })).toString('base64url');
    const sig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
    return `${payload}.${sig}`;
}

function verifikasiAdminToken(req) {
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!token || !token.includes('.')) return null;

    const [payload, sig] = token.split('.');
    const expectedSig = crypto.createHmac('sha256', ADMIN_SECRET).update(payload).digest('base64url');
    if (sig !== expectedSig) return null;

    try {
        const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
        if (!parsed.exp || Date.now() > parsed.exp) return null;
        return parsed;
    } catch {
        return null;
    }
}

function kirimJSON(res, statusCode, data) {
    res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=UTF-8' });
    res.end(JSON.stringify(data));
}

function bacaBodyJSON(req) {
    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', chunk => { raw += chunk.toString(); });
        req.on('end', () => {
            try {
                resolve(raw ? JSON.parse(raw) : {});
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Cek apakah isi kolom `pesan` menandakan transaksi sukses
// Cek apakah respon OtoMax benar-benar menandakan transaksi sukses (bukan gagal/pending/timeout)
function isTransaksiSukses(pesan = '') {
    const teks = String(pesan).toUpperCase();

    // Tolak jika jelas gagal, timeout, atau masih menunggu proses
    const isGagalAtauTimeout =
        /\bGAGAL\b/.test(teks) ||
        /\bTIMEOUT\b/.test(teks) ||
        /RC\s*:\s*(GAGAL|TIMEOUT)/.test(teks) ||
        /STS\s+(GAGAL|TIMEOUT)/.test(teks) ||
        /AKAN DIPROSES/.test(teks) ||
        /MENUNGGU JAWABAN/.test(teks);

    if (isGagalAtauTimeout) {
        return false;
    }

    // Terima jika ada indikasi sukses (termasuk kasus "sdh pernah ... sts Sukses" atau "RC:Sukses")
    return /\bSUKSES\b/.test(teks) || /RC\s*:\s*SUKSES/.test(teks) || /STS\s+SUKSES/.test(teks);
}

// Ambil nominal potong saldo: prioritas harga_jual/body, fallback ke "Stok Terpotong"
function ambilNominalPotong(data, pesan = '') {
    const hargaBody = Number(data.harga ?? data.amount ?? data.nominal ?? 0);
    if (Number.isFinite(hargaBody) && hargaBody > 0) {
        return hargaBody;
    }

    const matchStokPotong = String(pesan).match(/STOK\s+TERPOTONG\s*:?\s*([\d.]+)/i);
    if (matchStokPotong && matchStokPotong[1]) {
        const bersih = Number(matchStokPotong[1].replace(/\./g, ''));
        if (Number.isFinite(bersih) && bersih > 0) {
            return bersih;
        }
    }

    return 0;
}

// Ekstrak SN umum dari respon OtoMax jika tersedia
function ekstrakSN(pesan = '') {
   const teks = String(pesan);
    const matchRef = teks.match(/SN\/Ref\s*:?\s*([0-9-]+(?:\s*\/\s*[^\r\n.]+)?)/i);
    if (matchRef && matchRef[1]) {
        return matchRef[1].replace(/\s+/g, ' ').trim();
    }

    const matchSN = teks.match(/\bSN\s*[:=/#-]?\s*([A-Za-z0-9-]{6,})/i);
    return matchSN ? matchSN[1].trim() : null;
}

// Format rupiah sederhana
function formatRupiah(angka) {
    const num = Number(angka || 0);
    return 'Rp' + num.toLocaleString('id-ID');
}

// Susun pesan khusus untuk reseller saat transaksi sukses & saldo terpotong
function buatPesanSuksesReseller({ kodeTransaksi, produk, tujuan, pesanOtoMax, nominalPotong, saldoTerbaru }) {
    const sn = ekstrakSN(pesanOtoMax);
    const pln = ekstrakInfoPLN(pesanOtoMax);

    const barisSN = sn ? `\nSN/Ref: ${sn}` : '';
    const barisPln = [
        pln.idPel ? `IDPel: ${pln.idPel}` : null,
        pln.idMeter ? `IDMeter: ${pln.idMeter}` : null,
        pln.rpToken ? `Token: Rp${pln.rpToken}` : null
    ].filter(Boolean).join(' | ');

    const barisDetailPln = barisPln ? `\n${barisPln}` : '';
    const barisSaldo = saldoTerbaru !== undefined && saldoTerbaru !== null
        ? `\nSisa Saldo: ${formatRupiah(saldoTerbaru)}`
        : '';

    return [
        `Transaksi SUKSES (${kodeTransaksi})`,
        `Produk: ${produk}`,
        `Tujuan: ${tujuan}${barisSN}${barisDetailPln}`,
        `Potongan Saldo: ${formatRupiah(nominalPotong)}${barisSaldo}`
    ].join('\n');
}

const server = http.createServer(async (req, res) => {
    // 1. Header CORS diperbarui mendukung GET, POST, PUT, DELETE, OPTIONS, dan Authorization
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

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
                    const userID = data.userID ?? null;

                    // Cek apakah userID dari frontend terdaftar di kolom user_id pada tabel users
                    if (!userID || String(userID).trim() === '') {
                        res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('anda bukan reseller pulsa');
                        return;
                    }

                    if (!supabaseUrl || !supabaseKey) {
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('Konfigurasi Supabase belum lengkap.');
                        return;
                    }

                    const userIdClean = String(userID).trim();
                    const { data: resellerRow, error: resellerError } = await supabase
                        .from('users')
                        .select('id, user_id, status')
                        .eq('user_id', userIdClean)
                        .maybeSingle();

                    if (resellerError) {
                        console.error("Supabase Cek Reseller Error:", resellerError.message);
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('Gagal, memvalidasi data reseller tidak valid.');
                        return;
                    }

                    if (!resellerRow || String(resellerRow.user_id) !== userIdClean || (resellerRow.status && resellerRow.status !== 'aktif')) {
                        res.writeHead(403, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('Gagal, Anda bukan reseller pulsa');
                        return;
                    }

                    // Cek apakah produk dari frontend ada di produk_pulsa (baca huruf kecil & besar) dan is_aktif === true
                    const kodeProdukClean = String(product || '').trim().toUpperCase();
                    if (!kodeProdukClean) {
                        res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('Gagal, Kode produk tidak valid atau tidak aktif.');
                        return;
                    }

                    const { data: produkRows, error: produkValidError } = await supabase
                        .from('produk_pulsa')
                        .select('id, kode_produk, harga_jual, is_aktif')
                        .ilike('kode_produk', kodeProdukClean)
                        .eq('is_aktif', true)
                        .limit(1);

                    if (produkValidError) {
                        console.error("Supabase Cek Produk Error:", produkValidError.message);
                        res.writeHead(500, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end('Gagal memvalidasi produk pulsa.');
                        return;
                    }

                    const produkValid = Array.isArray(produkRows) ? produkRows[0] : null;
                    const kodeDbUpper = String(produkValid?.kode_produk || '').trim().toUpperCase();
                    if (!produkValid || kodeDbUpper !== kodeProdukClean || produkValid.is_aktif !== true) {
                        res.writeHead(400, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end(`Gagal, Kode produk ${kodeProdukClean} tidak valid atau tidak aktif.`);
                        return;
                    }

                    // Target URL ke OtoMax
                    const targetUrl = `http://49.128.180.101:18000/transaksi?memberID=${encodeURIComponent(memberID)}&product=${encodeURIComponent(product)}&dest=${encodeURIComponent(dest)}&refID=${encodeURIComponent(refID)}&sign=${encodeURIComponent(sign)}`;

                    console.log(`Memproses....`);

                    const controller = new AbortController();
                    const timeoutId = setTimeout(() => controller.abort(), 8000);

                    let responseText = "";
                    //sumulasi respon
                    // Contoh simulasi responseText sukses dari endpoint /transaksi
                    const simulatedSuccessResponse = [
                        `T#78074761 R# ${refID || "PLN20.14328128393"}`,
                        `SUKSES. SN/Ref:5745-1752-1091-8984-`,
                        ``,
                        `6308/SARIYANI/R1/450VA/46,4 . Stok Terpotong 19.875 .Stok 1.685.843`,
                        `@29/11 10:49:07 /Trx=271.`
                    ].join("\n");
                    
                    try {
                        const response = await fetch(targetUrl, { signal: controller.signal });
                        clearTimeout(timeoutId);
                       // responseText = await response.text();
                         responseText = simulatedSuccessResponse;
                    } catch (fetchErr) {
                        clearTimeout(timeoutId);
                        console.error("Gagal fetch ke OtoMax:", fetchErr.message);
                        res.writeHead(504, { 'Content-Type': 'text/plain; charset=UTF-8' });
                        res.end(`GAGAL_OTOMAX: Tidak dapat terhubung ke server OtoMax (${fetchErr.message})`);
                        return;
                    }

                    let pesanSuksesReseller = null;

                    // Simpan ke Supabase dan potong saldo jika kolom `pesan` (responseText) sukses
                    if (supabaseUrl && supabaseKey) {
                        const { data: insertedRow, error: insertError } = await supabase
                            .from('inbox_direct_transaksi')
                            .insert([{
                                kode_transaksi: refID,
                                tujuan: dest,
                                pesan: responseText,
                                tgl_entri: new Date().toISOString(),
                                user_id: userID,
                                pesan_sukses_ke_reseller: null
                            }])
                            .select('id')
                            .single();

                        if (insertError) {
                            console.error("Supabase Insert Error:", insertError.message);
                        } else if (isTransaksiSukses(responseText)) {
                            // 1. Cari harga jual dari tabel produk_pulsa jika ada
                            let nominalPotong = Number(produkValid?.harga_jual) || 0;
                            if (product) {
                                const { data: produkRow, error: produkError } = await supabase
                                    .from('produk_pulsa')
                                    .select('harga_jual, is_aktif')
                                    .eq('kode_produk', String(product).trim().toUpperCase())
                                    .single();

                                if (!produkError && produkRow && produkRow.is_aktif) {
                                    nominalPotong = Number(produkRow.harga_jual) || 0;
                                }
                            }

                            // 2. Fallback nominal jika tidak ada di produk_pulsa
                            if (nominalPotong <= 0) {
                                nominalPotong = ambilNominalPotong(data, responseText);
                            }

                            // 3. Potong saldo user secara atomik via RPC
                            if (userID && nominalPotong > 0) {
                                const { data: rpcResult, error: rpcError } = await supabase.rpc(
                                    'potong_saldo_transaksi',
                                    {
                                        p_user_id: String(userID),
                                        p_nominal: nominalPotong,
                                        p_kode_transaksi: String(refID)
                                    }
                                );

                                if (rpcError) {
                                    console.error("Gagal potong saldo (RPC Error):", rpcError.message);
                                } else if (rpcResult?.ok) {
                                    pesanSuksesReseller = buatPesanSuksesReseller({
                                        kodeTransaksi: refID,
                                        produk: product,
                                        tujuan: dest,
                                        pesanOtoMax: responseText,
                                        nominalPotong,
                                        saldoTerbaru: rpcResult.saldo_terbaru
                                    });

                                    if (insertedRow?.id) {
                                        const { error: updatePesanError } = await supabase
                                            .from('inbox_direct_transaksi')
                                            .update({ pesan_sukses_ke_reseller: pesanSuksesReseller })
                                            .eq('id', insertedRow.id);

                                        if (updatePesanError) {
                                            console.error("Gagal simpan pesan_sukses_ke_reseller:", updatePesanError.message);
                                        } else {
                                            console.log("Saldo berhasil dipotong & pesan reseller tersimpan:", {
                                                refID,
                                                nominalPotong,
                                                saldoTerbaru: rpcResult.saldo_terbaru
                                            });
                                        }
                                    }
                                } else {
                                    console.warn("Potong saldo tidak dieksekusi:", rpcResult);
                                }
                            } else {
                                console.warn("Transaksi sukses, tetapi userID atau nominal potong saldo tidak valid:", {
                                    refID,
                                    userID,
                                    nominalPotong
                                });
                            }
                        }
                    }

                    res.writeHead(200, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end(pesanSuksesReseller || responseText);

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
            const userID = parsedUrl.searchParams.get('userID') || '';
            const limitParam = parseInt(parsedUrl.searchParams.get('limit') || '20', 10);
            const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 100) : 20;
        
            let query = supabase
                .from('inbox_direct_transaksi')
                .select('id, kode_transaksi, tujuan, pesan, pesan_sukses_ke_reseller, tgl_entri, user_id')
                .order('tgl_entri', { ascending: false })
                .limit(limit);
        
          //  if (refID) {
            //    query = query.eq('kode_transaksi', refID);
          //  }
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
        
            const transaksiList = data || [];
            const kodeList = [...new Set(
                transaksiList.map(item => item.kode_transaksi).filter(Boolean)
            )];
        
            const mutasiByKode = new Map();
            if (kodeList.length > 0) {
                // Menggantikan query mutasi_saldo sebelumnya
                let mutasiQuery = supabase
                    .from('mutasi_saldo')
                    .select('kode_transaksi, user_id, saldo_sebelumnya, saldo_sesudahnya, nominal')
                    .in('kode_transaksi', kodeList);
        
                if (userID) {
                    mutasiQuery = mutasiQuery.eq('user_id', userID);
                }
        
                const { data: mutasiRows, error: mutasiError } = await mutasiQuery;
        
                if (mutasiError) {
                    console.error("Supabase Mutasi Error:", mutasiError.message);
                } else {
                    for (const m of (mutasiRows || [])) {
                        mutasiByKode.set(m.kode_transaksi, m);
                    }
                }
            }
        
            const rows = transaksiList.map(row => {
                const mutasi = mutasiByKode.get(row.kode_transaksi);
                return {
                    ...row,
                    pesan_reseller: row.pesan_sukses_ke_reseller || row.pesan,
                    saldo_sebelumnya: mutasi?.saldo_sebelumnya != null ? Number(mutasi.saldo_sebelumnya) : null,
                    saldo_terbaru: mutasi?.saldo_sesudahnya != null ? Number(mutasi.saldo_sesudahnya) : null,
                    user_id: mutasi?.user_id ?? row.user_id,
                    nominal: mutasi?.nominal != null ? Number(mutasi.nominal) : null
                };
            });
        
            res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify({
                status: true,
                data: rows
            }));
            return;
        }
        

        // Halaman Admin dari folder public/admin-saldo.html
        if (req.method === 'GET' && (parsedUrl.pathname === '/admin-saldo' || parsedUrl.pathname === '/admin-saldo.html')) {
            const filePath = path.join(__dirname, 'public', 'admin-saldo.html');
            fs.readFile(filePath, (err, content) => {
                if (err) {
                    res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
                    res.end('Halaman admin tidak ditemukan.');
                    return;
                }
                res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
                res.end(content);
            });
            return;
        }

        // Login Admin
        if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/login') {
            const { username, password } = await bacaBodyJSON(req);
            if (ADMIN_USER && ADMIN_PASS && username === ADMIN_USER && password === ADMIN_PASS) {
                const token = buatAdminToken(username);
                return kirimJSON(res, 200, { status: true, token, username });
            }
            return kirimJSON(res, 401, { status: false, message: 'Username atau password admin salah.' });
        }

        // Semua route /api/admin/* selain login wajib token valid
        if (parsedUrl.pathname.startsWith('/api/admin/')) {
            const adminSession = verifikasiAdminToken(req);
            if (!adminSession) {
                return kirimJSON(res, 401, { status: false, message: 'Sesi admin tidak valid atau sudah kedaluwarsa.' });
            }

            if (!supabaseUrl || !supabaseKey) {
                return kirimJSON(res, 500, { status: false, message: 'Konfigurasi Supabase belum lengkap.' });
            }

           // --- RESELLER (USERS) ---
            if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/resellers') {
                const { data, error } = await supabase
                    .from('users')
                    .select('id, user_id, auth_user_id, nama, email, no_hp, saldo, status, created_at')
                    .order('id', { ascending: false });
                if (error) return kirimJSON(res, 500, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, data: data || [] });
            }

            if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/resellers') {
                const { id, user_id, auth_user_id, nama, email, no_hp, saldo, status } = await bacaBodyJSON(req);
                if (!nama) return kirimJSON(res, 400, { status: false, message: 'Nama reseller wajib diisi.' });

                const rowInsert = {
                    user_id: user_id !== undefined && user_id !== null && String(user_id).trim() !== ''
                        ? String(user_id).trim()
                        : null,
                    auth_user_id: auth_user_id && String(auth_user_id).trim() !== ''
                        ? String(auth_user_id).trim()
                        : null,
                    nama: String(nama).trim(),
                    email: email ? String(email).trim() : null,
                    no_hp: no_hp ? String(no_hp).trim() : null,
                    saldo: Number(saldo || 0),
                    status: status || 'aktif'
                };

                if (id !== undefined && id !== null && String(id).trim() !== '') {
                    rowInsert.id = Number(id);
                }

                const { data, error } = await supabase
                    .from('users')
                    .insert([rowInsert])
                    .select()
                    .single();

                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 201, { status: true, data });
            }

            if (req.method === 'PUT' && parsedUrl.pathname === '/api/admin/resellers') {
                const { id, user_id, auth_user_id, nama, email, no_hp, saldo, status } = await bacaBodyJSON(req);
                if (!id) return kirimJSON(res, 400, { status: false, message: 'ID tabel users wajib diisi.' });

                const { data, error } = await supabase
                    .from('users')
                    .update({
                        user_id: user_id !== undefined && user_id !== null && String(user_id).trim() !== ''
                            ? String(user_id).trim()
                            : null,
                        auth_user_id: auth_user_id && String(auth_user_id).trim() !== ''
                            ? String(auth_user_id).trim()
                            : null,
                        nama: String(nama).trim(),
                        email: email ? String(email).trim() : null,
                        no_hp: no_hp ? String(no_hp).trim() : null,
                        saldo: Number(saldo ?? 0),
                        status: status || 'aktif',
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', id)
                    .select()
                    .single();

                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, data });
            }

            if (req.method === 'DELETE' && parsedUrl.pathname === '/api/admin/resellers') {
                const id = parsedUrl.searchParams.get('id');
                if (!id) return kirimJSON(res, 400, { status: false, message: 'Parameter id wajib ada.' });

                const { error } = await supabase.from('users').delete().eq('id', id);
                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, message: 'Reseller dihapus.' });
            }

            // --- PRODUK PULSA ---
            if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/produk') {
                const { data, error } = await supabase
                    .from('produk_pulsa')
                    .select('*')
                    .order('id', { ascending: false });
                if (error) return kirimJSON(res, 500, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, data: data || [] });
            }

            if (req.method === 'POST' && parsedUrl.pathname === '/api/admin/produk') {
                const bodyObj = await bacaBodyJSON(req);
                if (!bodyObj.kode_produk || !bodyObj.nama_produk || !bodyObj.provider) {
                    return kirimJSON(res, 400, { status: false, message: 'Kode produk, nama produk, dan provider wajib diisi.' });
                }

                const { data, error } = await supabase
                    .from('produk_pulsa')
                    .insert([{
                        kode_produk: String(bodyObj.kode_produk).trim().toUpperCase(),
                        nama_produk: String(bodyObj.nama_produk).trim(),
                        kategori: bodyObj.kategori || 'Pulsa',
                        provider: String(bodyObj.provider).trim(),
                        nominal: Number(bodyObj.nominal || 0),
                        harga_modal: Number(bodyObj.harga_modal || 0),
                        harga_jual: Number(bodyObj.harga_jual || 0),
                        is_aktif: Boolean(bodyObj.is_aktif ?? true),
                        keterangan: bodyObj.keterangan || null
                    }])
                    .select()
                    .single();

                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 201, { status: true, data });
            }

            if (req.method === 'PUT' && parsedUrl.pathname === '/api/admin/produk') {
                const bodyObj = await bacaBodyJSON(req);
                if (!bodyObj.id) return kirimJSON(res, 400, { status: false, message: 'ID produk wajib diisi.' });

                const { data, error } = await supabase
                    .from('produk_pulsa')
                    .update({
                        kode_produk: String(bodyObj.kode_produk).trim().toUpperCase(),
                        nama_produk: String(bodyObj.nama_produk).trim(),
                        kategori: bodyObj.kategori || 'Pulsa',
                        provider: String(bodyObj.provider).trim(),
                        nominal: Number(bodyObj.nominal || 0),
                        harga_modal: Number(bodyObj.harga_modal || 0),
                        harga_jual: Number(bodyObj.harga_jual || 0),
                        is_aktif: Boolean(bodyObj.is_aktif),
                        keterangan: bodyObj.keterangan || null,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', bodyObj.id)
                    .select()
                    .single();

                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, data });
            }

            if (req.method === 'DELETE' && parsedUrl.pathname === '/api/admin/produk') {
                const id = parsedUrl.searchParams.get('id');
                if (!id) return kirimJSON(res, 400, { status: false, message: 'Parameter id wajib ada.' });

                const { error } = await supabase.from('produk_pulsa').delete().eq('id', id);
                if (error) return kirimJSON(res, 400, { status: false, message: error.message });
                return kirimJSON(res, 200, { status: true, message: 'Produk dihapus.' });
            }

            // --- LOG TRANSAKSI (DENGAN PAGINATION) ---
            if (req.method === 'GET' && parsedUrl.pathname === '/api/admin/transaksi') {
                const kodeFilter = (parsedUrl.searchParams.get('kode') || '').trim();
                const userFilter = (parsedUrl.searchParams.get('user_id') || '').trim();
                const pageParam = parseInt(parsedUrl.searchParams.get('page') || '1', 10);
                const limitParam = parseInt(parsedUrl.searchParams.get('limit') || '25', 10);

                const page = Number.isFinite(pageParam) && pageParam > 0 ? pageParam : 1;
                const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(limitParam, 200) : 25;
                const from = (page - 1) * limit;
                const to = from + limit - 1;

                let query = supabase
                    .from('inbox_direct_transaksi')
                    .select('id, kode_transaksi, tujuan, pesan, pesan_sukses_ke_reseller, tgl_entri, user_id', { count: 'exact' })
                    .order('id', { ascending: false })
                    .range(from, to);

                if (kodeFilter) {
                    query = query.ilike('kode_transaksi', `%${kodeFilter}%`);
                }
                if (userFilter) {
                    query = query.eq('user_id', userFilter);
                }

                const { data, error, count } = await query;
                if (error) {
                    return kirimJSON(res, 500, { status: false, message: error.message });
                }

                const list = data || [];
                const kodeList = [...new Set(list.map(x => x.kode_transaksi).filter(Boolean))];
                const userIds = [...new Set(list.map(x => x.user_id).filter(Boolean))];

                const mutasiMap = new Map();
                if (kodeList.length > 0) {
                    const { data: mutasiRows, error: mutasiErr } = await supabase
                        .from('mutasi_saldo')
                        .select('kode_transaksi, nominal, saldo_sebelumnya, saldo_sesudahnya')
                        .in('kode_transaksi', kodeList);

                    if (!mutasiErr && mutasiRows) {
                        for (const m of mutasiRows) {
                            mutasiMap.set(m.kode_transaksi, m);
                        }
                    }
                }

                const userMap = new Map();
                if (userIds.length > 0) {
                    const { data: userRows, error: userErr } = await supabase
                        .from('users')
                        .select('id, nama')
                        .in('id', userIds);

                    if (!userErr && userRows) {
                        for (const u of userRows) {
                            userMap.set(String(u.id), u.nama);
                        }
                    }
                }

                const rows = list.map(item => {
                    const mutasi = mutasiMap.get(item.kode_transaksi);
                    return {
                        ...item,
                        nama_reseller: item.user_id ? (userMap.get(String(item.user_id)) || '-') : '-',
                        pesan_reseller: item.pesan_sukses_ke_reseller || item.pesan,
                        nominal_potong: mutasi ? Number(mutasi.nominal) : null,
                        saldo_sebelumnya: mutasi ? Number(mutasi.saldo_sebelumnya) : null,
                        saldo_terbaru: mutasi ? Number(mutasi.saldo_sesudahnya) : null
                    };
                });

                const total = count ?? rows.length;
                const totalPages = Math.max(1, Math.ceil(total / limit));

                return kirimJSON(res, 200, {
                    status: true,
                    data: rows,
                    pagination: {
                        page,
                        limit,
                        total,
                        totalPages
                    }
                });
            }

            return kirimJSON(res, 404, { status: false, message: 'Endpoint admin tidak ditemukan.' });
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
