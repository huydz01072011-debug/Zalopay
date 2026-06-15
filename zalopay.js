const axios = require('axios');
const crypto = require('crypto');
class Zalopay {
    constructor() {
        this.config = {};
    }
    loadData(data) {
        this.config = data;
        return this;
    }
    sha256(password) {
        return crypto.createHash('sha256').update(password).digest('hex');
    }
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
        try {
            const response = await axios.get(url, { headers: { ...this.getZaloHeader(), ...headers } });
            return response.data;
        } catch (e) {
            return e.response ? e.response.data : { error: e.message };
        }
    }
    async postRequest(url, data, isPlain = false) {
        try {
            const h = this.getZaloHeader();
            if (isPlain) {
                h['Content-Type'] = 'text/plain;charset=UTF-8';
                data = JSON.stringify(data);
            }
            const response = await axios.post(url, data, { headers: h });
            return response.data;
        } catch (e) {
            return e.response ? e.response.data : { error: e.message };
        }
    }
    async ZaloLogin_Cookie() {
        return await this.getRequest('https://sapi.zalopay.vn/v2/user/profile/kyc', {
            'Referer': `https://social.zalopay.vn/spa/v2?c=1&c_time=${Date.now()}`
        });
    }
    async getBalance_web() {
        return await this.getRequest('https://api.zalopay.vn/v2/user/balance', { 'Host': 'api.zalopay.vn' });
    }
    async income_outcome_web(month, year) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/income-outcome?days=5&months=${month}&year=${year}`);
    }
    async getHistoryV2_filter(limit, page_token, month) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions?page_size=${limit}&page_token=${page_token || ''}&filter_month=${month}`);
    }
    async getHistoryV2_web(limit, page_token) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions?page_size=${limit}&page_token=${page_token || ''}`);
    }
    async GET_TRANS_BY_TID_WEB(app_trans_id) {
        return await this.getRequest(`https://sapi.zalopay.vn/v2/history/transactions/${app_trans_id}?type=1`);
    }
    async History_full_filter(limit, month) {
        const transList = [];
        const res = await this.getHistoryV2_filter(limit, '', month);
        if (!res || !res.data || !res.data.transactions) {
            return { status: 'error', code: -5, message: 'Lỗi API hoặc Cookie hết hạn', data: res };
        }
        for (let tx of res.data.transactions) {
            if (tx.status_info.status !== 1) continue;
            const det = await this.GET_TRANS_BY_TID_WEB(tx.trans_id);
            if (!det || !det.data || !det.data.transaction) continue;
            const t = det.data.transaction;
            transList.push({
                trans_id: t.trans_id,
                order_code: t.app_trans_id,
                info: t.template_info?.custom_fields || [],
                sign: t.sign || "",
                balance_snapshot: tx.balance_snapshot || 0,
                trans_amount: t.trans_amount || 0,
                description: t.description || "",
                trans_time: t.trans_time || "",
                app_trans_id: t.app_trans_id || ""
            });
        }
        return { status: "success", zalopayMsg: transList };
    }
    async getTransactions2() {
        try {
            const history_url = 'https://sapi.zalopay.vn/v2/history/transactions?page_size=20';
            const headers = {
                'Cookie': this.config.cookie || '',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36 Edg/134.0.0.0'
            };
            const response_history = await axios.get(history_url, { headers });
            const data_history = response_history.data;
            const formatted_transactions = [];
            let counter = 0;
            if (data_history && data_history.data && Array.isArray(data_history.data.transactions)) {
                for (let transaction of data_history.data.transactions) {
                    if (transaction.trans_id) {
                        const trans_id = transaction.trans_id;
                        const url_detail = `https://sapi.zalopay.vn/v2/history/transactions/${trans_id}?type=1`;
                        const response_detail = await axios.get(url_detail, { headers });
                        const data_detail = response_detail.data;
                        if (data_detail && data_detail.data && data_detail.data.transaction) {
                            const trans = data_detail.data.transaction;
                            let noidung = '';
                            if (trans.template_info && Array.isArray(trans.template_info.custom_fields)) {
                                for (let field of trans.template_info.custom_fields) {
                                    if (field.name === 'Lời nhắn') {
                                        noidung = field.value || '';
                                        break;
                                    }
                                }
                            }
                            const type = (trans.sign && trans.sign == 1) ? 'IN' : 'OUT';
                            const transactionDate = trans.trans_time ? new Date(trans.trans_time).toISOString().substring(0, 10) : null;
                            const transactionID = trans.trans_id === '' ? trans.app_trans_id : trans.trans_id;
                            formatted_transactions.push({
                                transactionID,
                                amount: trans.charge_amount || trans.trans_amount || null,
                                description: (trans.description + ' ' + noidung).trim(),
                                transactionDate,
                                type
                            });
                        }
                        counter++;
                        if (counter % 10 === 0) {
                            await new Promise(r => setTimeout(r, 1500));
                        }
                    }
                }
                return {
                    status: 'success',
                    msg: 'Thành công',
                    transactions: formatted_transactions
                };
            } else {
                return {
                    status: 'error',
                    msg: 'Không tìm thấy thông tin giao dịch.',
                    transactions: [],
                    raw_response: data_history
                };
            }
        } catch (e) {
            return {
                status: 'error',
                msg: 'Phiên đăng nhập đã hết hạn vui lòng cập nhật lại cookie',
                transactions: []
            };
        }
    }
    async get_info_web(phone) {
        let p = phone.startsWith('0') ? '84' + phone.substring(1) : phone;
        return await this.getRequest(`https://sapi.zalopay.vn/v3/ibft/web/get-user-info?phone=${p}`, {
            'Referer': 'https://social.zalopay.vn/spa/v2/home-transfer'
        });
    }
    async Order_Money_web(info, msg, amount, cfm_token = '') {
        const data = {
            receiver_zalopay_id: "", receiver_zalo_id: "",
            receiver_name: info.data.name, receiver_avatar: info.data.avatar,
            amount: parseInt(amount), note: msg,
            zalo_token: "", media: { greeting_card: { theme_id: "142" } },
            utoken: "", zpp: decodeURIComponent(info.data.zpp)
        };
        if (cfm_token) data.cfm_token = cfm_token;
        const result = await this.postRequest('https://sapi.zalopay.vn/mt/v5/create-order-v2', data);
        if (!cfm_token && result?.error?.details?.error_info?.reason === 'Reason_DUPLICATE_ORDER') {
            const token = result.error.details.error_info.metadata?.cfm_token;
            if (token) {
                console.log('[Order_Money_web] Duplicate order detected, retrying with cfm_token');
                return await this.Order_Money_web(info, msg, amount, token);
            }
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
            callback_url: `zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=${Date.now()}&otp=`,
            card: null, is_zmp: false
        };
        return await this.postRequest('https://sapi.zalopay.vn/v2/cashier/pay', data, true);
    }
    async SendMoney_web(phone, msg, amount) {
        console.log('[SendMoney_web] Step 1: get_info_web for phone:', phone);
        const info = await this.get_info_web(phone);
        console.log('[SendMoney_web] get_info_web response:', JSON.stringify(info, null, 2));
        if (!info.data) return { status: 'error', message: info.error?.details?.localized_message?.message || 'SĐT không hợp lệ' };
        console.log('[SendMoney_web] Step 2: Order_Money_web amount:', amount);
        const order = await this.Order_Money_web(info, msg, amount);
        console.log('[SendMoney_web] Order_Money_web response:', JSON.stringify(order, null, 2));
        if (!order || (!order.data && !order.ac_order)) return { status: 'error', message: order?.error?.details?.localized_message?.message || 'Lỗi tạo đơn chuyển tiền' };
        const orderData = order.ac_order || order.data || {};
        order.app_id = orderData.app_id;
        order.app_trans_id = orderData.app_trans_id;
        order.order_token = orderData.order_token;
        order.app_time = Date.now();
        order.app_user = "ZaloPay";
        order.amount = amount;
        order.description = msg;
        order.mac = "";
        order.item = "[]";
        console.log('[SendMoney_web] Step 3: Get_assets_web');
        const assets = await this.Get_assets_web(order);
        console.log('[SendMoney_web] Get_assets_web response:', JSON.stringify(assets, null, 2));
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) {
                source_of_fund = assets.data.source_of_fund;
            } else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) {
                source_of_fund = assets.data.sources_of_fund[0];
            }
        }
        if (!source_of_fund || source_of_fund.status !== 1) {
            return { status: 'error', message: source_of_fund?.message || 'Lỗi nguồn tiền/Số dư' };
        }
        if (Number(source_of_fund.balance) < Number(amount)) return { status: 'error', message: 'Số Dư Không Đủ' };
        console.log('[SendMoney_web] Step 4: Pay_Money_web');
        const pay = await this.Pay_Money_web(assets);
        console.log('[SendMoney_web] Pay_Money_web response:', JSON.stringify(pay, null, 2));
        if (!pay || pay.error) return { status: 'error', message: pay.error?.details?.localized_message?.message || 'Chuyển tiền thất bại' };
        const orderDataRes = order.ac_order || order.data || {};
        if (pay.data && (pay.data.is_processing === 1 || pay.data.is_processing === true)) {
            return {
                status: 'success', message: 'Chuyển Tiền Thành Công',
                data: {
                    zp_trans_id: pay.data.zp_trans_id || orderDataRes.order_no, partner_name: info.data.name,
                    partner_id: info.data.zalopay_id, amount: amount, owner_phone: this.config.phone
                }
            };
        }
        return { status: 'error', message: 'Trạng thái chuyển không xác định' };
    }
    async Create_QR_web(amount, note) {
        return await this.postRequest('https://sapi.zalopay.vn/v1/mt/flex-qrcode/generate', {
            amount: parseInt(amount), message: note, size: 190
        }, true);
    }
    async get_name_bank_web(stk, bankcode) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/inquiry';
        const data = { bank_code: bankcode, bank_number: stk, type: 0 };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try {
            const resp = await axios.post(url, JSON.stringify(data), { headers: h });
            return resp.data;
        } catch(e) { return e.response ? e.response.data : { error: e.message }; }
    }
    async createorder_send_bank_web(stk, config_bank, info_data, amount, description) {
        const url = 'https://scard.zalopay.vn/v1/mt/ibft-switch/tof/create-order';
        const data = {
            amount: parseInt(amount), bank_code: config_bank.bankcode,
            bank_holder_name: info_data.bank_holder_name, bank_number: stk,
            ii_type: 0, inquiry_info: info_data.inquiry_info, message: description,
            nickname: info_data.nickname, save: info_data.saved || false, type: info_data.type || 0
        };
        const h = this.getZaloHeader(); h['Host'] = 'scard.zalopay.vn'; h['Content-Type'] = 'text/plain;charset=UTF-8';
        try {
            const resp = await axios.post(url, JSON.stringify(data), { headers: h });
            return resp.data;
        } catch(e) { return e.response ? e.response.data : { error: e.message }; }
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
            callback_url: `zalo://qr/jp/nibvlsoj2j?cb_t=dotp&k=${Date.now()}&otp=`, card: null, is_zmp: false
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
        order.app_id = order.ac_order.app_id;
        order.app_trans_id = order.ac_order.app_trans_id;
        order.order_token = order.ac_order.order_token;
        order.app_time = Date.now();
        order.app_user = "ZaloPay";
        order.amount = amount;
        order.description = description;
        order.mac = "";
        order.item = `{"ibfttype":2,"ibfttranstype":1,"ext":"Người nhận:${info.bank_holder_name}\\tNgân hàng:${config_bank.bankcode}\\tSố tài khoản:**** ${numberBank4}","number":"","bcbankcode":"${config_bank.bcbankcode}","bimid":"","bimtoken":"","first6no":"${first6}","last4no":"${numberBank4}"}`;
        const assets = await this.assets_bank_web(order);
        let source_of_fund = null;
        if (assets && assets.data) {
            if (assets.data.source_of_fund) {
                source_of_fund = assets.data.source_of_fund;
            } else if (assets.data.sources_of_fund && assets.data.sources_of_fund.length > 0) {
                source_of_fund = assets.data.sources_of_fund[0];
            }
        }
        if (!source_of_fund || Number(source_of_fund.balance) < Number(amount)) {
            return { status: 'error', message: assets?.error?.details?.localized_message?.message || source_of_fund?.message || 'Lỗi tiền dư hoặc không tìm thấy nguồn tiền' };
        }
        const pay = await this.pay_bank_web(assets);
        if (pay && pay.data && pay.data.is_processing) {
            return { status: 'success', message: 'Chuyển bank thành công', data: { zp_trans_id: pay.data.zp_trans_id } };
        }
        return { status: 'error', message: pay?.error?.details?.localized_message?.message || 'Lỗi chuyển tiền' };
    }
}
module.exports = Zalopay;
