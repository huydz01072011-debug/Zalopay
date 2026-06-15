const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');

// ==================== DATABASE LAYER ====================
const DB_PATH = path.join(__dirname, 'db.json');

async function readDB() {
    try {
        const data = await fs.readFile(DB_PATH, 'utf-8');
        const parsed = JSON.parse(data || '{"accounts":[],"transactions":[]}');
        if (!parsed.accounts) parsed.accounts = [];
        if (!parsed.transactions) parsed.transactions = [];
        return parsed;
    } catch (e) {
        if (e.code === 'ENOENT') {
            const initial = { accounts: [], transactions: [] };
            await writeDB(initial);
            return initial;
        }
        throw e;
    }
}

async function writeDB(data) {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

async function getAccounts() { const db = await readDB(); return db.accounts; }
async function getAccountByPhone(phone) { const accounts = await getAccounts(); return accounts.find(acc => acc.phone === phone) || null; }
async function getAccountById(id) { const accounts = await getAccounts(); return accounts.find(acc => acc.id === id) || null; }
async function saveAccount(accountData) {
    const db = await readDB();
    const index = db.accounts.findIndex(acc => acc.phone === accountData.phone);
    if (index !== -1) db.accounts[index] = { ...db.accounts[index], ...accountData };
    else { accountData.id = accountData.id || Date.now().toString(); db.accounts.push(accountData); }
    await writeDB(db); return true;
}
async function removeAccount(id) {
    const db = await readDB(); db.accounts = db.accounts.filter(acc => acc.id !== id); await writeDB(db); return true;
}
async function logTransaction(transactionData) {
    const db = await readDB();
    db.transactions.push({ id: Date.now().toString(), time: Math.floor(Date.now() / 1000), date_time: new Date().toLocaleDateString('en-GB'), ...transactionData });
    await writeDB(db); return true;
}

// ==================== ZALOPAY CLASS ====================
class Zalopay {
    constructor() { this.config = {}; }
    loadData(data) { this.config = data; return this; }
    sha256(password) { return crypto.createHash('sha256').update(password).digest('hex'); }
    getZaloHeader(isSapi = true) {
        return {
            'Cookie': this.config.cookie || '',
            'Accept': '*/*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0',
            'Accept-Language': 'vi-VN,vi;q=0.9',
            ...(isSapi ? { 'Host': 'sapi.zalopay.vn' } : {})
        };
    }
    async getRequest(url, headers = {}) {
        try { const res = await axios.get(url, { headers: { ...this.getZaloHeader(), ...headers } }); return res.data; }
        catch (e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async postRequest(url, data, isPlain = false) {
        try {
            const h = this.getZaloHeader();
            if (isPlain) { h['Content-Type'] = 'text/plain;charset=UTF-8'; data = JSON.stringify(data); }
            const res = await axios.post(url, data, { headers: h }); return res.data;
        } catch (e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async ZaloLogin_Cookie() {
        return await this.getRequest('https://sapi.zalopay.vn/v2/user/profile/kyc', { 'Referer': 'https://social.zalopay.vn/spa/v2?c=1&c_time=' + Date.now() });
    }
    async getBalance_web() {
        return await this.getRequest('https://api.zalopay.vn/v2/user/balance', { 'Host': 'api.zalopay.vn' });
    }
    async income_outcome_web(month, year) {
        return await this.getRequest('https://sapi.zalopay.vn/v2/history/income-outcome?days=5&months=' + month + '&year=' + year);
    }
    async getTransactions2() {
        try {
            const history_url = 'https://sapi.zalopay.vn/v2/history/transactions?page_size=20';
            const headers = { 'Cookie': this.config.cookie || '', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' };
            const response_history = await axios.get(history_url, { headers });
            const data_history = response_history.data;
            const formatted_transactions = [];
            let counter = 0;
            if (data_history && data_history.data && Array.isArray(data_history.data.transactions)) {
                for (let transaction of data_history.data.transactions) {
                    if (transaction.trans_id) {
                        const trans_id = transaction.trans_id;
                        const url_detail = 'https://sapi.zalopay.vn/v2/history/transactions/' + trans_id + '?type=1';
                        const response_detail = await axios.get(url_detail, { headers });
                        const data_detail = response_detail.data;
                        if (data_detail && data_detail.data && data_detail.data.transaction) {
                            const trans = data_detail.data.transaction;
                            let noidung = '';
                            if (trans.template_info && Array.isArray(trans.template_info.custom_fields)) {
                                for (let field of trans.template_info.custom_fields) {
                                    if (field.name === 'Lời nhắn') { noidung = field.value || ''; break; }
                                }
                            }
                            const type = (trans.sign && trans.sign == 1) ? 'IN' : 'OUT';
                            const transactionDate = trans.trans_time ? new Date(trans.trans_time).toISOString().substring(0, 10) : null;
                            const transactionID = trans.trans_id === '' ? trans.app_trans_id : trans.trans_id;
                            formatted_transactions.push({ transactionID, amount: trans.charge_amount || trans.trans_amount || null, description: (trans.description + ' ' + noidung).trim(), transactionDate, type });
                        }
                        counter++;
                        if (counter % 10 === 0) await new Promise(r => setTimeout(r, 1500));
                    }
                }
                return { status: 'success', msg: 'Thành công', transactions: formatted_transactions };
            } else {
                return { status: 'error', msg: 'Không tìm thấy thông tin giao dịch.', transactions: [], raw_response: data_history };
            }
        } catch (e) {
            return { status: 'error', msg: 'Phiên đăng nhập đã hết hạn vui lòng cập nhật lại cookie', transactions: [] };
        }
    }
    async get_info_web(phone) {
        let p = phone.startsWith('0') ? '84' + phone.substring(1) : phone;
        return await this.getRequest('https://sapi.zalopay.vn/v3/ibft/web/get-user-info?phone=' + p, { 'Referer': 'https://social.zalopay.vn/spa/v2/home-transfer' });
    }
    async Order_Money_web(info, msg, amount, cfm_token = '') {
        const data = {
            receiver_zalopay_id: "", receiver_zalo_id: "", receiver_name: info.data.name, receiver_avatar: info.data.avatar,
            amount: parseInt(amount), note: msg, zalo_token: "", media: { greeting_card: { theme_id: "142" } },
            utoken: "", zpp: decodeURIComponent(info.data.zpp)
        };
        if (cfm_token) data.cfm_token = cfm_token;
        const result = await this.postRequest('https://sapi.zalopay.vn/mt/v5/create-order-v2', data);
        if (!cfm_token && result?.error?.details?.error_info?.reason === 'Reason_DUPLICATE_ORDER') {
            const token = result.error.details.error_info.metadata?.cfm_token;
            if (token) return await this.Order_Money_web(info, msg, amount, token);
        }
        return result;
    }
    async Get_assets_web(order) {
        const url = 'https://sapi.zalopay.vn/v2/cashier/assets';
        const data = {
            order_type: "FULL_ORDER", full_assets: true,
            order_data: {
                app_id: order.app_id, app_trans_id: order.app_trans_id, app_time: order.app_time,
                app_user: order.app_user, amount: order.amount, item: order.item || "[]",
                description: order.description, embed_data: order.embeddata ? JSON.stringify(order.embeddata) : '"{}"',
                mac: order.mac || "", trans_type: 1, product_code: "TF007",
                service_fee: { fee_amount: 0, total_free_trans: 0, remain_free_trans: 0 }
            },
            token_data: { trans_token: "", app_id: order.app_id, order_token: order.order_token },
            campaign_code: "", display_mode: 1
        };
        return await this.postRequest(url, data, true);
    }
    async Pay_Money_web(assets) {
        const data = {
            authenticator: { authen_type: 1, auth_info: "eyJhdXRoX3R5cGUiOjF9", pin: this.sha256(this.config.password) },
            order_fee: [0], order_token: assets.data.order_token,
            promotion_token: "", service_id: 19,
            sof_token: assets.data.sources_of_fund[0].sof_token,
            user_fee: [0], zalo_token: "",
            callback_url: 'zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=' + Date.now() + '&otp=',
            card: null, is_zmp: false
        };
        return await this.postRequest('https://sapi.zalopay.vn/v2/cashier/pay', data, true);
    }
    async SendMoney_web(phone, msg, amount) {
        const info = await this.get_info_web(phone);
        if (!info.data) return { status: 'error', message: info.error?.details?.localized_message?.message || 'SĐT không hợp lệ' };
        const order = await this.Order_Money_web(info, msg, amount);
        if (!order || (!order.data && !order.ac_order)) return { status: 'error', message: order?.error?.details?.localized_message?.message || 'Lỗi tạo đơn chuyển tiền' };
        const orderData = order.ac_order || order.data || {};
        order.app_id = orderData.app_id; order.app_trans_id = orderData.app_trans_id; order.order_token = orderData.order_token;
        order.app_time = Date.now(); order.app_user = "ZaloPay"; order.amount = amount; order.description = msg; order.mac = ""; order.item = "[]";
        const assets = await this.Get_assets_web(order);
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) source_of_fund = assets.data.source_of_fund;
            else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) source_of_fund = assets.data.sources_of_fund[0];
        }
        if (!source_of_fund || source_of_fund.status !== 1) return { status: 'error', message: source_of_fund?.message || 'Lỗi nguồn tiền/Số dư' };
        if (Number(source_of_fund.balance) < Number(amount)) return { status: 'error', message: 'Số Dư Không Đủ' };
        const pay = await this.Pay_Money_web(assets);
        if (!pay || pay.error) return { status: 'error', message: pay.error?.details?.localized_message?.message || 'Chuyển tiền thất bại' };
        const orderDataRes = order.ac_order || order.data || {};
        if (pay.data && (pay.data.is_processing === 1 || pay.data.is_processing === true)) {
            return { status: 'success', message: 'Chuyển Tiền Thành Công', data: { zp_trans_id: pay.data.zp_trans_id || orderDataRes.order_no, partner_name: info.data.name, partner_id: info.data.zalopay_id, amount: amount, owner_phone: this.config.phone } };
        }
        return { status: 'error', message: 'Trạng thái chuyển không xác định' };
    }
    async Create_QR_web(amount, note) {
        return await this.postRequest('https://sapi.zalopay.vn/v1/mt/flex-qrcode/generate', { amount: parseInt(amount), message: note, size: 190 }, true);
    }
    async get_name_bank_web(stk, bankcode) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/inquiry';
        const data = { bank_code: bankcode, bank_number: stk, type: 0 };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try { const resp = await axios.post(url, JSON.stringify(data), { headers: h }); return resp.data; }
        catch (e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async createorder_send_bank_web(stk, config_bank, info_data, amount, description) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/create-order';
        const data = { amount: parseInt(amount), bank_code: config_bank.bankcode, bank_holder_name: info_data.bank_holder_name, bank_number: stk, ii_type: 0, inquiry_info: info_data.inquiry_info, message: description, nickname: info_data.nickname, save: info_data.saved || false, type: info_data.type || 0 };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try { const resp = await axios.post(url, JSON.stringify(data), { headers: h }); return resp.data; }
        catch (e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async assets_bank_web(order) {
        const url = 'https://sapi.zalopay.vn/v2/cashier/assets';
        const data = {
            order_type: "FULL_ORDER", full_assets: true,
            order_data: {
                app_id: order.app_id, app_trans_id: order.app_trans_id, app_time: order.app_time,
                app_user: order.app_user, amount: order.amount, item: JSON.stringify(order.item),
                description: order.description, embed_data: order.embeddata ? JSON.stringify(order.embeddata) : '"{}"',
                mac: order.mac, trans_type: 1, product_code: "TF007",
                service_fee: { fee_amount: 0, total_free_trans: 0, remain_free_trans: 0 }
            },
            token_data: { trans_token: "", app_id: order.app_id, order_token: order.order_token },
            campaign_code: "", display_mode: 1
        };
        return await this.postRequest(url, data, true);
    }
    async pay_bank_web(assets) {
        const data = {
            authenticator: { authen_type: 1, auth_info: "eyJhdXRoX3R5cGUiOjF9", pin: this.sha256(this.config.password) },
            order_fee: [0], order_token: assets.data.order_token, promotion_token: "", service_id: 19,
            sof_token: assets.data.sources_of_fund[0].sof_token, user_fee: [0], zalo_token: "",
            callback_url: 'zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=' + Date.now() + '&otp=', card: null, is_zmp: false
        };
        return await this.postRequest('https://sapi.zalopay.vn/v2/cashier/pay', data, true);
    }
    async SendMoney_Bank_web(stk, amount, description, config_bank) {
        const info = await this.get_name_bank_web(stk, config_bank.bankcode);
        if (!info || !info.bank_holder_name) return { status: 'error', message: 'STK rỗng hoặc không đúng' };
        const order = await this.createorder_send_bank_web(stk, config_bank, info, amount, description);
        if (!order || !order.ac_order) return { status: 'error', message: order?.error?.details?.localized_message?.message || 'Tạo lệnh thất bại' };
        let numberBank4 = stk.slice(-4);
        let first6 = stk.substring(0, 6);
        order.app_id = order.ac_order.app_id; order.app_trans_id = order.ac_order.app_trans_id; order.order_token = order.ac_order.order_token;
        order.app_time = Date.now(); order.app_user = "ZaloPay"; order.amount = amount; order.description = description; order.mac = "";
        order.item = '{"ibfttype":2,"ibfttranstype":1,"ext":"Người nhận:' + info.bank_holder_name + '\\tNgân hàng:' + config_bank.bankcode + '\\tSố tài khoản:**** ' + numberBank4 + '","number":"","bcbankcode":"' + config_bank.bcbankcode + '","bimid":"","bimtoken":"","first6no":"' + first6 + '","last4no":"' + numberBank4 + '"}';
        const assets = await this.assets_bank_web(order);
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) source_of_fund = assets.data.source_of_fund;
            else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) source_of_fund = assets.data.sources_of_fund[0];
        }
        if (!source_of_fund || Number(source_of_fund.balance) < Number(amount)) return { status: 'error', message: assets?.error?.details?.localized_message?.message || source_of_fund?.message || 'Lỗi tiền dư hoặc không tìm thấy nguồn tiền' };
        const pay = await this.pay_bank_web(assets);
        if (pay && pay.data && pay.data.is_processing) return { status: 'success', message: 'Chuyển bank thành công', data: { zp_trans_id: pay.data.zp_trans_id } };
        return { status: 'error', message: pay?.error?.details?.localized_message?.message || 'Lỗi chuyển tiền' };
    }
}

// ==================== EXPRESS SERVER & GIAO DIỆN HTML ====================
const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Giao diện HTML (đã sửa lỗi backtick, dùng nối chuỗi ở những chỗ cần thiết)
app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="vi">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>⚡ ZaloPay CyberVault</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
    <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Quicksand:wght@300;500;700&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg: #0a0c10;
            --card-bg: rgba(18, 22, 33, 0.85);
            --border-glow: #00f0ff;
            --accent: #ff00c8;
            --text: #e0e0ff;
            --neon-blue: #00d4ff;
            --neon-pink: #ff00c8;
            --neon-green: #39ff14;
        }
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            background: radial-gradient(circle at 20% 20%, #0a0c10 0%, #000000 100%);
            color: var(--text);
            font-family: 'Quicksand', sans-serif;
            min-height: 100vh;
            position: relative;
            overflow-x: hidden;
        }
        body::before {
            content: '';
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background-image: linear-gradient(rgba(0,240,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(0,240,255,0.03) 1px, transparent 1px);
            background-size: 40px 40px;
            pointer-events: none;
            animation: moveGrid 20s linear infinite;
        }
        @keyframes moveGrid { 0% { transform: translate(0,0); } 100% { transform: translate(40px,40px); } }
        .glass-card {
            background: var(--card-bg);
            backdrop-filter: blur(20px);
            border: 1px solid rgba(0,240,255,0.2);
            box-shadow: 0 0 30px rgba(0,240,255,0.15), inset 0 0 10px rgba(255,255,255,0.05);
            border-radius: 20px;
            transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
            color: inherit;
        }
        .glass-card:hover {
            box-shadow: 0 0 40px rgba(0,240,255,0.4), 0 0 80px rgba(255,0,200,0.2);
            border-color: var(--neon-blue);
            transform: translateY(-5px);
        }
        .section-title {
            font-family: 'Orbitron', sans-serif; font-weight: 700; text-transform: uppercase;
            background: linear-gradient(90deg, var(--neon-blue), var(--accent));
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            letter-spacing: 2px; text-shadow: 0 0 20px rgba(0,240,255,0.5);
        }
        .btn-neon {
            background: transparent; border: 1px solid var(--neon-blue); color: var(--neon-blue);
            border-radius: 8px; padding: 8px 16px; font-weight: 600;
            transition: all 0.3s; text-shadow: 0 0 5px var(--neon-blue);
        }
        .btn-neon:hover { background: var(--neon-blue); color: #000; box-shadow: 0 0 20px var(--neon-blue); text-shadow: none; }
        .btn-neon-pink { border-color: var(--neon-pink); color: var(--neon-pink); text-shadow: 0 0 5px var(--neon-pink); }
        .btn-neon-pink:hover { background: var(--neon-pink); box-shadow: 0 0 20px var(--neon-pink); color: #000; }
        .btn-neon-green { border-color: var(--neon-green); color: var(--neon-green); text-shadow: 0 0 5px var(--neon-green); }
        .btn-neon-green:hover { background: var(--neon-green); box-shadow: 0 0 20px var(--neon-green); color: #000; }
        .account-card {
            background: linear-gradient(145deg, rgba(20,30,48,0.9), rgba(10,14,23,0.9));
            border: 1px solid rgba(0,240,255,0.25); backdrop-filter: blur(16px);
            border-radius: 24px; padding: 20px; margin-bottom: 25px;
            transition: all 0.4s; position: relative; overflow: hidden;
        }
        .account-card::before {
            content: ''; position: absolute; top: -50%; left: -50%;
            width: 200%; height: 200%;
            background: conic-gradient(from 0deg, transparent, rgba(0,240,255,0.1), transparent, rgba(255,0,200,0.1), transparent);
            animation: rotateGlow 6s linear infinite; z-index: 0;
        }
        @keyframes rotateGlow { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        .account-card > * { position: relative; z-index: 1; }
        .avatar-img {
            width: 70px; height: 70px; border-radius: 50%;
            border: 2px solid var(--neon-blue); box-shadow: 0 0 20px var(--neon-blue);
            object-fit: cover; transition: 0.3s;
        }
        .balance-glow {
            font-family: 'Orbitron', monospace; font-weight: 900;
            color: var(--neon-green); text-shadow: 0 0 10px var(--neon-green); font-size: 1.3rem;
        }
        .spinner {
            width: 50px; height: 50px; border: 3px solid rgba(0,240,255,0.2);
            border-top-color: var(--neon-blue); border-radius: 50%;
            animation: spin 0.8s linear infinite; box-shadow: 0 0 20px var(--neon-blue);
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .modal-content {
            background: rgba(10,14,23,0.95); backdrop-filter: blur(25px);
            border: 1px solid var(--neon-blue); box-shadow: 0 0 40px rgba(0,240,255,0.3);
            color: var(--text); border-radius: 20px;
        }
        .modal-header { border-bottom: 1px solid rgba(0,240,255,0.3); }
        .modal-footer { border-top: 1px solid rgba(0,240,255,0.3); }
        input, select, textarea {
            background: rgba(0,0,0,0.5) !important; border: 1px solid rgba(0,240,255,0.3) !important;
            color: white !important; border-radius: 8px !important;
        }
        input:focus, select:focus, textarea:focus {
            box-shadow: 0 0 15px var(--neon-blue) !important; border-color: var(--neon-blue) !important;
        }
        label { color: #ccc; font-weight: 500; }
        .swal2-popup {
            background: rgba(15,20,30,0.95) !important; backdrop-filter: blur(20px);
            border: 1px solid var(--neon-blue) !important; border-radius: 20px; color: white;
        }
        .swal2-title, .swal2-content { color: white !important; }
    </style>
</head>
<body>
<div class="container py-5 position-relative">
    <div class="text-center mb-5">
        <h1 class="display-4 section-title mb-2">⚡ ZALOPAY CYBERVAULT</h1>
        <p class="text-muted"><i class="fa-solid fa-shield-haltered"></i> Quản lý tài khoản & giao dịch với phong cách Hacker</p>
        <hr class="mx-auto" style="width: 100px; height: 3px; background: linear-gradient(90deg, var(--neon-blue), var(--accent));">
    </div>
    <div class="row justify-content-center mb-5">
        <div class="col-lg-8">
            <div class="glass-card p-4">
                <h4 class="mb-3 text-center"><i class="fa-solid fa-user-plus me-2"></i>Thêm Tài Khoản Mới</h4>
                <form id="loginForm">
                    <input type="hidden" name="action" value="LOGIN">
                    <div class="row g-3">
                        <div class="col-md-4"><input type="text" class="form-control" name="phone" placeholder="SĐT" required></div>
                        <div class="col-md-4"><input type="password" class="form-control" name="password" placeholder="Mật khẩu ví" required></div>
                        <div class="col-md-12"><textarea class="form-control" name="cookie" rows="2" placeholder="Dán Cookie (zpw_sek=...)" required></textarea></div>
                    </div>
                    <button type="submit" class="btn btn-neon w-100 mt-3"><i class="fa-solid fa-plus"></i> THÊM / CẬP NHẬT</button>
                </form>
            </div>
        </div>
    </div>
    <div class="row" id="accountsList">
        <div class="col-12 text-center py-5"><div class="spinner mx-auto"></div><p class="mt-3 text-muted">Đang tải dữ liệu...</p></div>
    </div>
</div>

<!-- Transfer Modal -->
<div class="modal fade" id="modalTransfer" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content glass-card" style="border-radius:20px;">
            <div class="modal-header"><h5 class="modal-title"><i class="fa-solid fa-paper-plane me-2"></i>Chuyển ZaloPay</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
                <form id="formTransfer">
                    <input type="hidden" name="action" value="transfer"><input type="hidden" name="account" id="tf_account"><input type="hidden" name="password" id="tf_password">
                    <div class="mb-3"><label>Người nhận (SĐT)</label><input type="text" name="receiver" class="form-control" required></div>
                    <div class="mb-3"><label>Số tiền</label><input type="number" name="amount" class="form-control" required></div>
                    <div class="mb-3"><label>Lời nhắn</label><input type="text" name="comment" class="form-control" value="Chuyen tien"></div>
                    <button type="submit" class="btn btn-neon w-100">GỬI TIỀN</button>
                </form>
            </div>
        </div>
    </div>
</div>

<!-- Bank Transfer Modal -->
<div class="modal fade" id="modalBank" tabindex="-1">
    <div class="modal-dialog">
        <div class="modal-content glass-card">
            <div class="modal-header"><h5 class="modal-title"><i class="fa-solid fa-building-columns me-2"></i>Chuyển Ngân Hàng</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
            <div class="modal-body">
                <form id="formBank">
                    <input type="hidden" name="action" value="transfer_bank"><input type="hidden" name="account" id="bk_account"><input type="hidden" name="password" id="bk_password"><input type="hidden" name="name" id="bk_name_hidden">
                    <div class="mb-3"><label>Chọn Ngân Hàng</label><select name="bank" id="bk_bank_select" class="form-select"><option value="">Đang tải danh sách...</option></select></div>
                    <div class="mb-3"><label>Số Tài Khoản</label><div class="input-group"><input type="text" name="stk" id="bk_stk" class="form-control" required><button class="btn btn-outline-light" type="button" onclick="checkNameBank()"><i class="fa-solid fa-magnifying-glass"></i> Check</button></div></div>
                    <div class="mb-3"><label>Tên Người Nhận</label><input type="text" id="bk_name_display" class="form-control" readonly style="background: rgba(255,255,255,0.1)!important;"></div>
                    <div class="mb-3"><label>Số tiền</label><input type="number" name="amount" class="form-control" required></div>
                    <div class="mb-3"><label>Lời nhắn</label><input type="text" name="comment" class="form-control" value="Chuyen khoan"></div>
                    <button type="submit" class="btn btn-neon-pink w-100">CHUYỂN KHOẢN</button>
                </form>
            </div>
        </div>
    </div>
</div>

<!-- History Modal -->
<div class="modal fade" id="modalHistory" tabindex="-1">
    <div class="modal-dialog modal-lg">
        <div class="modal-content glass-card">
            <div class="modal-header"><h5 class="modal-title"><i class="fa-solid fa-clock-rotate-left me-2"></i>Lịch Sử Giao Dịch</h5><button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal"></button></div>
            <div class="modal-body"><div class="table-responsive"><table class="table table-dark table-hover"><thead class="text-neon-blue"><tr><th>Mã GD</th><th>Thời gian</th><th>Số tiền</th><th>Nội dung</th><th>Số dư</th></tr></thead><tbody id="historyBody"></tbody></table></div></div>
        </div>
    </div>
</div>

<script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/sweetalert2@11"></script>
<script>
    const API_URL = '/api.php';
    const API_ACCOUNTS = '/api/accounts';
    function loadAccounts() {
        $.getJSON(API_ACCOUNTS, function(res) {
            if (res.status === 'success') {
                const arr = res.data;
                const container = $('#accountsList');
                container.empty();
                if (arr.length === 0) {
                    container.html('<div class="col-12 text-center text-muted py-5">Chưa có tài khoản nào. Hãy thêm ngay!</div>');
                    return;
                }
                arr.forEach(row => {
                    const statusBadge = row.status === 'success' 
                                        ? '<span class="badge bg-success">Live</span>' 
                                        : '<span class="badge bg-danger">Die</span>';
                    const avatar = row.avatar || 'https://via.placeholder.com/70';
                    const name = row.name || 'Ẩn danh';
                    const timeUpdate = new Date((row.time_login || 0) * 1000).toLocaleString();
                    container.append(
                        '<div class="col-md-6 col-lg-4">' +
                            '<div class="account-card">' +
                                '<div class="d-flex align-items-center justify-content-between mb-3">' +
                                    '<div class="d-flex align-items-center">' +
                                        '<img src="' + avatar + '" class="avatar-img me-3">' +
                                        '<div><h5 class="mb-0" style="color: white;">' + name + '</h5><small class="text-muted">' + row.phone + '</small></div>' +
                                    '</div>' +
                                    statusBadge +
                                '</div>' +
                                '<p class="mb-1"><span class="text-light">Số dư:</span> <span class="balance-glow">' + formatMoney(row.balance || 0) + '</span></p>' +
                                '<p class="text-muted small mb-3">Cập nhật: ' + timeUpdate + '</p>' +
                                '<div class="d-grid gap-2">' +
                                    '<button onclick="reloadBalance(\'' + row.id + '\')" class="btn btn-neon btn-sm"><i class="fa-solid fa-rotate"></i> Cập nhật số dư</button>' +
                                    '<div class="btn-group">' +
                                        '<button onclick="openModalTransfer(\'' + row.phone + '\', \'' + row.password + '\')" class="btn btn-neon btn-sm"><i class="fa-solid fa-paper-plane"></i> Chuyển Zalo</button>' +
                                        '<button onclick="openModalBank(\'' + row.phone + '\', \'' + row.password + '\')" class="btn btn-neon-pink btn-sm"><i class="fa-solid fa-building-columns"></i> Bank</button>' +
                                    '</div>' +
                                    '<button onclick="viewHistory(\'' + row.phone + '\')" class="btn btn-neon-green btn-sm text-dark"><i class="fa-solid fa-history"></i> Lịch sử</button>' +
                                    '<button onclick="removeAcc(\'' + row.id + '\')" class="btn btn-outline-danger btn-sm"><i class="fa-solid fa-trash"></i> Xóa</button>' +
                                '</div>' +
                            '</div>' +
                        '</div>'
                    );
                });
            }
        });
    }
    $(document).ready(function() { 
        loadAccounts(); 
        $.getJSON('https://api.vietqr.io/v2/banks', function(res) {
            if (res.code === "00" && res.data) {
                let options = '';
                res.data.forEach(function(bank) {
                    if (bank.transferSupported === 1) {
                        let val = bank.bin + '-' + bank.code + '-' + bank.shortName + '-' + bank.name;
                        options += '<option value="' + val + '">' + bank.shortName + ' (' + bank.name + ')</option>';
                    }
                });
                $('#bk_bank_select').html(options);
            } else {
                $('#bk_bank_select').html('<option value="">Lỗi tải danh sách NH</option>');
            }
        });
    });
    $('#loginForm').submit(function(e){
        e.preventDefault();
        Swal.fire({title: 'Đang xử lý...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
        $.post(API_URL, $(this).serialize(), function(res){
            if(res.status == 'success') Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts());
            else Swal.fire('Lỗi', res.msg, 'error');
        });
    });
    function reloadBalance(id){
        Swal.fire({title: 'Đang cập nhật...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
        $.post(API_URL, {action: 'RELOADBALANCE', id: id}, function(res){
            if(res.status == 'success') Swal.fire('Xong', res.msg, 'success').then(() => loadAccounts());
            else Swal.fire('Lỗi', res.msg, 'error');
        });
    }
    function viewHistory(phone){
        $('#modalHistory').modal('show');
        $('#historyBody').html('<tr><td colspan="5" class="text-center"><div class="spinner mx-auto"></div></td></tr>');
        $.post(API_URL, {action: 'history', phone: phone, limit: 10}, function(res){
            if(res.status == 'success' && res.transactions){
                let html = '';
                res.transactions.forEach(item => {
                    let money = item.type === 'IN' ? '<span class="text-success">+' + formatMoney(item.amount) + '</span>' : '<span class="text-danger">-' + formatMoney(item.amount) + '</span>';
                    html += '<tr><td><small>' + item.transactionID + '</small></td><td><small>' + item.transactionDate + '</small></td><td>' + money + '</td><td><small>' + item.description + '</small></td><td></td></tr>';
                });
                $('#historyBody').html(html);
            } else {
                $('#historyBody').html('<tr><td colspan="5" class="text-center text-danger">' + res.msg + '</td></tr>');
            }
        });
    }
    function openModalTransfer(phone, pass){ $('#tf_account').val(phone); $('#tf_password').val(pass); $('#modalTransfer').modal('show'); }
    $('#formTransfer').submit(function(e){
        e.preventDefault();
        Swal.fire({ title: 'Xác nhận chuyển', text: 'Chắc chắn muốn chuyển tiền?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Có, chuyển!', cancelButtonText: 'Hủy' }).then((result) => {
            if (result.isConfirmed) {
                Swal.fire({title: 'Đang chuyển...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
                $.post(API_URL, $('#formTransfer').serialize(), function(res){
                    if(res.status == 'success'){ $('#modalTransfer').modal('hide'); Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts()); }
                    else Swal.fire('Thất bại', res.msg, 'error');
                });
            }
        });
    });
    function openModalBank(phone, pass){ $('#bk_account').val(phone); $('#bk_password').val(pass); $('#modalBank').modal('show'); $('#bk_name_display').val(''); $('#bk_name_hidden').val(''); $('#bk_stk').val(''); }
    function checkNameBank(){
        let phone = $('#bk_account').val(); let stk = $('#bk_stk').val(); let bank = $('#bk_bank_select').val();
        if(!stk) { Swal.fire('Lỗi', 'Nhập số tài khoản trước', 'error'); return; }
        $('#bk_name_display').val('Đang kiểm tra...');
        $.post(API_URL, {action: 'NameBank', phone: phone, stk: stk, bank: bank}, function(res){
            if(res.status == 'success'){ $('#bk_name_display').val(res.msg); $('#bk_name_hidden').val(res.msg); Swal.fire({ toast: true, position: 'top-end', showConfirmButton: false, timer: 3000, icon: 'success', title: 'Đã check tên!' }); }
            else { $('#bk_name_display').val('Không tìm thấy tên'); Swal.fire('Lỗi', res.msg, 'error'); }
        });
    }
    $('#formBank').submit(function(e){
        e.preventDefault();
        if($('#bk_name_hidden').val() == '') { Swal.fire('Chú ý', 'Vui lòng Check Tên trước khi chuyển!', 'warning'); return; }
        Swal.fire({ title: 'Xác nhận chuyển tiền', text: 'Chắc chắn chuyển cho: ' + $('#bk_name_hidden').val() + '?', icon: 'info', showCancelButton: true, confirmButtonText: 'Chuyển Khoản!', cancelButtonText: 'Hủy' }).then((result) => {
            if (result.isConfirmed) {
                Swal.fire({title: 'Đang xử lý...', text: 'Vui lòng chờ...', allowOutsideClick: false, didOpen: () => { Swal.showLoading(); }});
                $.post(API_URL, $('#formBank').serialize(), function(res){
                    if(res.status == 'success'){ $('#modalBank').modal('hide'); Swal.fire('Thành công', res.msg, 'success').then(() => loadAccounts()); }
                    else Swal.fire('Thất bại', res.msg, 'error');
                });
            }
        });
    });
    function removeAcc(id){
        Swal.fire({ title: 'Xóa tài khoản?', text: 'Bạn có chắc chắn muốn xóa?', icon: 'warning', showCancelButton: true, confirmButtonText: 'Xóa', cancelButtonText: 'Hủy' }).then((result) => {
            if (result.isConfirmed) {
                $.post(API_URL, {action: 'REMOVE', id: id}, function(res){
                    Swal.fire('Đã xóa', '', 'success').then(() => loadAccounts());
                });
            }
        });
    }
    function formatMoney(amount) {
        return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
    }
</script>
</body>
</html>
    `);
});

// API routes
function randomString(length) {
    let chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let str = '';
    for (let i = 0; i < length; i++) str += chars.charAt(Math.floor(Math.random() * chars.length));
    return str;
}

app.get('/api/accounts', async (req, res) => {
    try {
        const accounts = await getAccounts();
        res.json({ status: 'success', data: accounts });
    } catch (e) {
        res.json({ status: 'error', msg: e.message });
    }
});

app.post('/api.php', async (req, res) => {
    try {
        const action = req.body.action || '';
        const z = new Zalopay();
        switch (action) {
            case 'LOGIN': {
                const { phone, password, cookie } = req.body;
                if (!phone || !password || !cookie) return res.json({ status: 'error', msg: 'Vui lòng nhập đầy đủ: SĐT, Mật khẩu, Cookie' });
                const token_api = crypto.createHash('md5').update(randomString(6) + Date.now()).digest('hex');
                let account = await getAccountByPhone(phone);
                if (account) { account.type_api = 'web'; account.cookie = cookie; account.status = 'pending'; }
                else account = { phone, type_api: 'web', cookie, status: 'pending', userID: 1, token_api, id: Date.now().toString() };
                await saveAccount(account);
                z.loadData(account);
                const info = await z.ZaloLogin_Cookie();
                if (!info.error && info.data) {
                    account.password = password;
                    account.name = info.data.display_name;
                    account.avatar = info.data.avatar;
                    account.zalo_id = info.data.zalo_id;
                    account.user_id = info.data.zalopay_id;
                    account.profile_level = info.data.profile_level;
                    account.status = 'success';
                    account.errorDesc = 'Thành Công';
                    account.time_login = Math.floor(Date.now() / 1000);
                    const balanceReq = await z.getBalance_web();
                    if (balanceReq?.data?.balance !== undefined) account.balance = balanceReq.data.balance;
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Đăng nhập thành công' });
                } else {
                    account.status = 'error'; account.errorDesc = 'Cookie Không Hợp Lệ';
                    await saveAccount(account);
                    return res.json({ status: 'error', msg: 'Cookie Không Hợp Lệ hoặc Lỗi login' });
                }
            }
            case 'RELOADBALANCE': {
                const { id } = req.body;
                const account = await getAccountById(id);
                if (!account) return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
                z.loadData(account);
                const balanceReq = await z.getBalance_web();
                if (!balanceReq.error) {
                    const month = new Date().getMonth() + 1;
                    const year = new Date().getFullYear();
                    const revenue = await z.income_outcome_web(month, year);
                    if (revenue?.data?.income_outcome?.length > 0) {
                        account.receive_mon = revenue.data.income_outcome[0].income_amount || 0;
                        account.ex_mon = revenue.data.income_outcome[0].outcome_amount || 0;
                    }
                    if (balanceReq.data?.balance !== undefined) account.balance = balanceReq.data.balance;
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật số dư thành công: ' + account.balance + 'đ' });
                } else {
                    account.status = 'out'; account.errorDesc = 'Cookie Die';
                    await saveAccount(account);
                    return res.json({ status: 'error', msg: 'Lỗi lấy số dư (Cookie có thể đã chết)' });
                }
            }
            case 'history': {
                const { phone } = req.body;
                const account = await getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Không tìm thấy tài khoản', transactions: [] });
                z.loadData(account);
                const history = await z.getTransactions2();
                return res.json(history);
            }
            case 'update': {
                const { phone, cookie } = req.body;
                if (!phone || !cookie) return res.json({ status: 'error', msg: 'Thiếu thông tin' });
                const account = await getAccountByPhone(phone);
                if (account) {
                    account.cookie = cookie; account.time_login = Math.floor(Date.now() / 1000); account.status = 'pending';
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật cookie thành công' });
                }
                return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
            }
            case 'REMOVE': {
                const { id } = req.body;
                await removeAccount(id);
                return res.json({ status: 'success', msg: 'Đã xóa tài khoản' });
            }
            case 'transfer': {
                const { receiver, account: phone, amount, comment, password } = req.body;
                if (!receiver || !phone || !amount || !password) return res.json({ status: 'error', msg: 'Nhập thiếu thông tin chuyển tiền' });
                const account = await getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
                if (account.password !== password) return res.json({ status: 'error', msg: 'Mật khẩu sai' });
                z.loadData(account);
                const send = await z.SendMoney_web(receiver, comment, amount);
                if (send.status === 'error') return res.json({ status: 'error', msg: send.message });
                else {
                    const balanceReq = await z.getBalance_web();
                    if (!balanceReq.error && balanceReq.data?.balance !== undefined) { account.balance = balanceReq.data.balance; await saveAccount(account); }
                    await logTransaction({ type_gd: 'sendmoney', tranId: send.data.zp_trans_id, partnerId: receiver, amount, comment, status: 'success', message: 'Chuyển Tiền Thành Công', user_id: 1 });
                    return res.json({ status: 'success', msg: 'Chuyển thành công. Số dư: ' + (account.balance || 0) });
                }
            }
            case 'CreateQR': {
                const { id, amount } = req.body;
                const account = await getAccountById(id);
                if (!account) return res.json({ status: 'error', msg: 'Acc không tồn tại' });
                z.loadData(account);
                const qr = await z.Create_QR_web(amount, '');
                return res.json({ status: 'success', msg: 'OK', data: qr });
            }
            case 'NameBank': {
                const { phone, stk, bank } = req.body; 
                const account = await getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Acc không tồn tại' });
                const data_config = bank.split('-');
                z.loadData(account);
                const nameInfo = await z.get_name_bank_web(stk, data_config[1]);
                if (nameInfo.error || !nameInfo.bank_holder_name) return res.json({ status: 'error', msg: 'Lỗi không xác định hoặc không tìm thấy tên' });
                return res.json({ status: 'success', msg: nameInfo.bank_holder_name, data: nameInfo });
            }
            case 'transfer_bank': {
                const { account: phone, stk, bank, amount, comment, password, name } = req.body;
                if (!phone || !stk || !amount || !password) return res.json({ status: 'error', msg: 'Thiếu thông tin' });
                const account = await getAccountByPhone(phone);
                if (!account) return res.json({ status: 'error', msg: 'Acc lỗi' });
                if (account.password !== password) return res.json({ status: 'error', msg: 'Sai mật khẩu' });
                const data_bank = bank.split('-');
                const config_bank = { bankcode: data_bank[1], bcbankcode: data_bank[0] };
                z.loadData(account);
                const send = await z.SendMoney_Bank_web(stk, amount, comment, config_bank);
                if (send.status === 'error') return res.json({ status: 'error', msg: send.message });
                else {
                    const balanceReq = await z.getBalance_web();
                    if (!balanceReq.error && balanceReq.data?.balance !== undefined) { account.balance = balanceReq.data.balance; await saveAccount(account); }
                    await logTransaction({ type_gd: 'sendbank', tranId: send.data.zp_trans_id, partnerId: stk, partnerName: name, amount, comment, status: 'success', user_id: 1 });
                    return res.json({ status: 'success', msg: 'Chuyển Bank thành công. Số dư: ' + (account.balance || 0) });
                }
            }
            case 'ANTI': {
                const { phone, status, ip } = req.body;
                const account = await getAccountByPhone(phone);
                if (account) {
                    account.ip_white = ip; account.status_ip_white = status;
                    await saveAccount(account);
                    return res.json({ status: 'success', msg: 'Cập nhật cấu hình IP thành công' });
                }
                return res.json({ status: 'error', msg: 'Tài khoản không tồn tại' });
            }
            default: return res.json({ status: 'error', msg: 'Unknown Action' });
        }
    } catch (e) {
        return res.json({ status: 'error', msg: 'Lỗi Server: ' + e.message, stack: e.stack });
    }
});

const PORT = 8000;
app.listen(PORT, '0.0.0.0', () => console.log('⚡ ZaloPay CyberVault running on http://0.0.0.0:' + PORT));