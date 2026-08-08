// ==UserScript==
// @name         DS Enhance Max (满血版) [适用最新DeepSeek网页]
// @namespace    https://chat.deepseek.com/
// @version      8.0.5
// @description  【满血升级】突破原生限制！支持 AI 智能会话搜索、AI 自动化标签整理、多大模型 API 自由切换、原生隔离级批量管理。集成批量删除、导出、自定义提示词以及批量FORK等满血增强功能。
// @author       TRYuuu
// @license      MIT
// @match        *://chat.deepseek.com/*
// @icon         https://fe-static.deepseek.com/chat/favicon.svg
// @grant        none
// @run-at       document-start
// ==/UserScript==

/*
 * MIT License
 * 
 * Copyright (c) 2026 TRYuuu
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

(function () {
    'use strict';

    const CONFIG = {
        listApi: '/api/v0/chat_session/fetch_page',
        detailApi: '/api/v0/chat_session/fetch_messages',
        deleteApi: '/api/v0/chat_session/delete',
        pageSize: 50,
        deleteInterval: 400,
        maxConcurrent: 3,
    };

    const LS_PROMPTS = 'dse_prompts';
    const CUSTOM_PROMPT_MARKER = '[自定义提示词]';

    // ==================== 1. 自定义提示词拦截引擎 (必须在 document-start 执行) ====================
    let _capturedToken = null;
    let lastInjectedSignature = null;

    // ==================== 状态响应拦截 (实时同步UI) ====================
    const origSetItem = localStorage.setItem;
    localStorage.setItem = function(key, value) {
        origSetItem.call(this, key, value);
        if ((key === 'ds_global_tags' || key === 'ds_local_tags') && typeof window.__dsSyncTagUI === 'function') {
            setTimeout(window.__dsSyncTagUI, 10);
        }
    };
    const origRemoveItem = localStorage.removeItem;
    localStorage.removeItem = function(key) {
        origRemoveItem.call(this, key);
        if ((key === 'ds_global_tags' || key === 'ds_local_tags') && typeof window.__dsSyncTagUI === 'function') {
            setTimeout(window.__dsSyncTagUI, 10);
        }
    };

    // 监听 URL 变化重置指纹（解决切换房间不触发新提示词的问题）
    const originalPushState = history.pushState;
    history.pushState = function(...args) {
        const newUrl = args[2];
        if (newUrl) {
            const oldPath = location.pathname;
            const newPath = newUrl.toString().startsWith('http') ? new URL(newUrl).pathname : new URL(newUrl, location.origin).pathname;
            if (oldPath !== '/' && oldPath !== newPath) lastInjectedSignature = null;
        }
        return originalPushState.apply(this, args);
    };
    window.addEventListener('popstate', () => { lastInjectedSignature = null; });

    function getEnabledPrompts() {
        try {
            const arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
            if (Array.isArray(arr) && arr.length) return arr.filter(p => p.enabled).map(p => p.content).filter(Boolean);
        } catch(e) {}
        return [];
    }

    function modifyRequest(bodyStr) {
        const enabled = getEnabledPrompts();
        const currentSignature = enabled.join('\n\n');

        if (!currentSignature) { lastInjectedSignature = null; return bodyStr; }
        if (!bodyStr || bodyStr.includes(CUSTOM_PROMPT_MARKER)) return bodyStr;
        if (lastInjectedSignature === currentSignature) return bodyStr;

        try {
            const parsed = JSON.parse(bodyStr);
            const tagged = `${CUSTOM_PROMPT_MARKER}\n${currentSignature}`;
            let injected = false;

            if (parsed.prompt && typeof parsed.prompt === 'string') {
                parsed.prompt = parsed.prompt + '\n\n' + tagged;
                injected = true;
            }
            if (parsed.messages && parsed.messages.length > 0) {
                const lastIdx = parsed.messages.length - 1;
                if (parsed.messages[lastIdx].role === 'USER') {
                    parsed.messages[lastIdx].content = parsed.messages[lastIdx].content + '\n\n' + tagged;
                    injected = true;
                }
            }

            if (injected) {
                lastInjectedSignature = currentSignature;
                return JSON.stringify(parsed);
            }
        } catch(e) {}
        return bodyStr;
    }

    (function installInterceptor() {
        const origFetch = window.fetch;
        window.fetch = async function(input, init = {}) {
            try {
                const url = typeof input === 'string' ? input : input?.url || '';

                // 捕获 Token
                if (url.includes('/api/') && init?.headers) {
                    const h = init.headers;
                    const auth = (h instanceof Headers) ? h.get('Authorization') : (h['Authorization'] || h['authorization']);
                    if (auth && auth.startsWith('Bearer ')) _capturedToken = auth.replace(/^Bearer\s+/i, '').trim();
                }

                // 注入提示词
                if (url.includes('completion') && init?.body && typeof init.body === 'string') {
                    init.body = modifyRequest(init.body);
                }
            } catch(e) {}
            return origFetch.apply(this, arguments);
        };

        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;
        const _xhrMeta = new WeakMap();

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            _xhrMeta.set(this, { url });
            return origOpen.apply(this, [method, url, ...rest]);
        };

        XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
            if (/^authorization$/i.test(name) && typeof value === 'string' && value.startsWith('Bearer ')) {
                _capturedToken = value.replace(/^Bearer\s+/i, '').trim();
            }
            return origSetHeader.apply(this, arguments);
        };

        XMLHttpRequest.prototype.send = function(body) {
            const meta = _xhrMeta.get(this);
            if (meta && meta.url.includes('completion') && typeof body === 'string') {
                body = modifyRequest(body);
            }
            return origSend.apply(this, [body]);
        };
    })();

    // ==================== 2. 等待 DOM 准备完毕 ====================
    function waitForDOM() {
        return new Promise(resolve => {
            if (document.body) resolve();
            else new MutationObserver(() => { if (document.body) resolve(); })
                .observe(document.documentElement, { childList: true });
        });
    }

    waitForDOM().then(() => {
        // ==================== 以下为 UI 与功能逻辑 ====================
        window.dsAlert = function(msg, type = 'success', duration = 3000) {
            let container = document.getElementById('ds-toast-container');
            if (!container) {
                container = document.createElement('div');
                container.id = 'ds-toast-container';
                container.className = 'ds-toast-container';
                document.body.appendChild(container);
            }
            const toast = document.createElement('div');
            toast.className = `ds-toast ${type}`;
            const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : '⚠️';
            toast.innerHTML = `<span>${icon}</span><span>${msg}</span>`;
            container.appendChild(toast);
            setTimeout(() => {
                toast.style.animation = 'ds-toast-out 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards';
                setTimeout(() => toast.remove(), 300);
            }, duration);
        };

        window.dsConfirm = function(msg, title = "操作确认") {
            return new Promise((resolve) => {
                const overlay = document.createElement('div');
                overlay.className = 'ds-modal-overlay';
                
        overlay.addEventListener('click', (e) => {
            // Prevent DeepSeek's global document click handler from crashing
            if (e.target && (e.target.tagName === 'svg' || e.target.tagName === 'path' || e.target.closest('.ds-tab-btn'))) {
                e.stopPropagation();
            }
        }, true);

        overlay.innerHTML = `
                    <div class="ds-modal-box">
                        <h3 class="ds-modal-title">${title}</h3>
                        <div class="ds-modal-content">${msg}</div>
                        <div class="ds-modal-actions">
                            <button class="ds-modal-btn ds-modal-cancel" id="ds-modal-cancel">取消</button>
                            <button class="ds-modal-btn ds-modal-confirm" id="ds-modal-confirm">确认</button>
                        </div>
                    </div>
                `;
                // 挂载到 html 根节点，完全跳出 body 可能存在的层叠上下文或点击拦截
                document.documentElement.appendChild(overlay);
                
                const cancelBtn = overlay.querySelector('.ds-modal-cancel');
                const confirmBtn = overlay.querySelector('.ds-modal-confirm');
                
                cancelBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    overlay.remove();
                    resolve(false);
                });
                
                confirmBtn.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    overlay.remove();
                    resolve(true);
                });
            });
        };


    function getToken() {
        // 1. 优先使用拦截到的真实 Token
        if (_capturedToken && _capturedToken.length > 20) return _capturedToken;
        // 2. 回退：尝试 localStorage / sessionStorage
        const storageKeys = ['userToken', 'token', 'accessToken', 'Authorization', 'user_token', 'auth_token'];
        for (const store of [localStorage, sessionStorage]) {
            for (const key of storageKeys) {
                try {
                    const val = store.getItem(key);
                    if (val && val.length > 20) return val.replace(/^Bearer\s+/i, '');
                } catch(e) {}
            }
        }
        // 3. 回退：Cookie
        const cm = document.cookie.match(/(?:token|access_token|auth_token|userToken)=([^;]+)/i);
        if (cm) return decodeURIComponent(cm[1]);
        return null;
    }

    // ==================== API 请求封装 ====================
    // GET 请求：参数拼接到 URL query string，不带 body
    async function apiGet(path, params = {}) {
        const token = getToken();
        const headers = { 'Accept': 'application/json' };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const qs = new URLSearchParams(params).toString();
        const url = qs ? `${path}?${qs}` : path;

        const resp = await fetch(url, {
            method: 'GET',
            headers,
            credentials: 'include',
        });

        if (resp.status === 401) throw new Error('身份验证失败（401），请刷新页面后重新登录');
        if (resp.status === 429) throw new Error('请求过于频繁（429），请稍后再试');
        if (!resp.ok) throw new Error(`HTTP ${resp.status} [GET ${path}]`);

        const json = await resp.json();
        // DeepSeek 鉴权失败会返回 200 但 code=40003
        if (json?.code === 40003 || json?.code === 401) {
            throw new Error(
                `鉴权失败（code=${json.code}）\n` +
                `《解决方法》：关闭本弹窗，在 DeepSeek 页面点击任意一条历史对话，等待 1 秒后再次点击『开始扫描』。` +
                `（原因：页面初始化时 Token 尚未被捕获）`
            );
        }
        return json;
    }

    // POST 请求：body 为 JSON
    async function apiPost(path, body = {}) {
        const token = getToken();
        const headers = {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
        };
        if (token) headers['Authorization'] = `Bearer ${token}`;

        const resp = await fetch(path, {
            method: 'POST',
            headers,
            credentials: 'include',
            body: JSON.stringify(body),
        });

        if (resp.status === 401) throw new Error('身份验证失败（401），请刷新页面后重新登录');
        if (resp.status === 429) throw new Error('请求过于频繁（429），请稍后再试');
        if (!resp.ok) throw new Error(`HTTP ${resp.status} [POST ${path}]`);
        return resp.json();
    }

    // ==================== 增强能力 API 封装 ====================
    const apiRename = (id, title) => apiPost('/api/v0/chat_session/update_title', { chat_session_id: id, title });
    const apiHistory = (id) => apiGet('/api/v0/chat/history_messages', { chat_session_id: id });
    const apiCreateShare = (sid, mids) => apiPost('/api/v0/share/create', { chat_session_id: sid, message_ids: mids });
    const apiForkShare = (shareId) => apiPost('/api/v0/share/fork', { share_id: shareId });

    // ==================== 获取全量会话列表 ====================
    async function fetchAllSessions(onProgress, debugLog, syncState = null) {
        const sessions = syncState ? syncState.sessions : [];
        let cursor = syncState ? syncState.cursor : 0;
        let hasMore = syncState ? syncState.hasMore : true;
        let isFirstPage = (cursor === 0 || cursor === '0');
        let lastFirstId = null;

        while (hasMore) {
            // 列表接口使用 GET + query 参数
            const data = await apiGet(CONFIG.listApi, {
                count: CONFIG.pageSize,
                cursor: cursor,
            });

            // ★ 首页诊断：打印原始结构的顶层 key，帮助定位字段路径
            if (isFirstPage && debugLog) {
                isFirstPage = false;
                const preview = JSON.stringify(data).slice(0, 600);
                debugLog(`[诊断] 原始响应（前600字符）：${preview}`);
            }

            // 穷举所有已知的返回结构路径
            const list =
                data?.data?.biz_data?.chat_sessions ||
                data?.biz_data?.chat_sessions ||
                data?.data?.biz_data?.session_list ||
                data?.biz_data?.session_list ||
                data?.data?.chat_sessions ||
                data?.chat_sessions ||
                data?.data?.sessions ||
                data?.sessions ||
                data?.data?.items ||
                data?.items ||
                data?.data?.list ||
                data?.list ||
                data?.data?.data ||          // 双重 data 嵌套
                (Array.isArray(data?.data) ? data.data : null) ||
                [];

            if (!Array.isArray(list) || list.length === 0) {
                if (debugLog && sessions.length === 0) {
                    debugLog(`[诊断] 未找到会话列表，响应顶层字段：${Object.keys(data || {}).join(', ')}`);
                    if (data?.data) debugLog(`[诊断] data 内字段：${Object.keys(data.data || {}).join(', ')}`);
                }
                hasMore = false;
                break;
            }

            if (debugLog && list.length > 0) {
                const first = list[0];
                debugLog(`[拉取] 本批次获取 ${list.length} 条。示例: [${first.title || first.name || '无标题'}] (ID: ${first.id || first.chat_session_id})`);
            }

            // 死循环保护：如果本次拉取的第一条数据与上次完全一样，说明后端不吃当前的 cursor 参数，强制中断
            if (list.length > 0) {
                const currentFirstId = list[0].id || list[0].chat_session_id;
                if (currentFirstId && currentFirstId === lastFirstId) {
                    if (debugLog) debugLog(`[警告] 接口返回了重复的首页数据，后端可能不再支持当前分页参数。为了避免死循环，已强制终止全量拉取。`);
                    hasMore = false;
                    break;
                }
                lastFirstId = currentFirstId;
            }

            list.forEach(s => {
                sessions.push({
                    id: s.id || s.chat_session_id || s.session_id || s.sessionId,
                    title: s.title || s.name || s.chat_session_title || s.session_title || '（无标题）',
                });
            });

            // 判断翻页
            let nextCursor =
                data?.data?.biz_data?.cursor ||
                data?.biz_data?.cursor ||
                data?.data?.cursor ||
                data?.cursor ||
                null;

            // 如果接口没有明确返回 cursor，但返回了 has_more，则尝试取最后一条数据的 id 或 seq_id 作为游标
            const hasNext = data?.data?.biz_data?.has_more ??
                data?.data?.has_more ??
                data?.hasMore ??
                (list.length === CONFIG.pageSize);

            if (hasNext && !nextCursor && list.length > 0) {
                const lastItem = list[list.length - 1];
                nextCursor = lastItem.seq_id || lastItem.id || lastItem.inserted_at;
            }

            if (nextCursor && nextCursor !== cursor) {
                cursor = nextCursor;
            } else {
                hasMore = false;
            }

            // 如果传入了 syncState，实时更新以便中断时可以保留
            if (syncState) {
                syncState.cursor = cursor;
                syncState.hasMore = hasMore;
            }

            if (onProgress) onProgress(sessions.length);
            if (hasMore) await sleep(200); // 增加分页拉取延迟防止过多请求触发限制
        }
        return sessions;
    }


    // ==================== 获取单个会话消息内容（API 方式）====================
    async function fetchSessionMessages(sessionId) {
        try {
            // 详情接口使用 GET + query 参数
            const data = await apiGet(CONFIG.detailApi, {
                chat_session_id: sessionId,
            });

            const messages =
                data?.data?.biz_data?.chat_messages ||
                data?.biz_data?.chat_messages ||
                data?.data?.messages ||
                data?.messages ||
                data?.data?.chat_messages ||
                [];

            return messages.map(m => {
                // content 字段可能是字符串或数组（多模态）
                if (typeof m.content === 'string') return m.content;
                if (Array.isArray(m.content)) return m.content.map(c => c.text || '').join('');
                return m.text || m.message || '';
            }).join('\n');
        } catch (e) {
            return ''; // 获取详情失败时跳过，不中断整体流程
        }
    }

    // ==================== DOM 降级模式（API 鉴权失败时自动切换）====================

    /**
     * 直接从侧边栏 DOM 读取所有历史会话列表。
     * 依赖 DeepSeek 页面产出的 <a href="/a/chat/s/xxx"> 结构。
     */
    function fetchSessionsFromDOM() {
        const sessions = [];
        // 侧边栏中所有会话链接
        const links = document.querySelectorAll('a[href*="/a/chat/s/"]');
        links.forEach(a => {
            const href = a.getAttribute('href') || '';
            const idMatch = href.match(/\/a\/chat\/s\/([\w-]+)/);
            if (!idMatch) return;
            const id = idMatch[1];
            // 标题文本：优先找 .c08e6e93，fallback 到元素自身文本
            const titleEl = a.querySelector('.c08e6e93') ||
                            a.querySelector('[class*="title"]') ||
                            a.querySelector('[class*="name"]');
            const title = (titleEl?.textContent || a.textContent || '（无标题）').trim();
            if (id && !sessions.find(s => s.id === id)) {
                sessions.push({ id, title, href });
            }
        });
        return sessions;
    }

    /**
     * DOM 自动向下滚动抓取（究极全量抓取方案，规避 API 翻页游标被加密/屏蔽的问题）
     */
    async function autoScrollSidebar(onProgress, debugLog) {
        return new Promise((resolve, reject) => {
            const links = document.querySelectorAll('a[href*="/a/chat/s/"]');
            if (links.length === 0) {
                return reject(new Error('未在页面发现任何会话，请确认已登录且侧边栏已展开'));
            }

            // 往上找具备 overflow 的滚动容器
            let scrollEl = null;
            let curr = links[0].parentElement;
            while(curr && curr !== document.body) {
                const style = window.getComputedStyle(curr);
                if ((style.overflowY === 'auto' || style.overflowY === 'scroll' || style.overflowY === 'overlay' || style.overflow === 'auto' || style.overflow === 'hidden' || style.overflow === 'overlay') && curr.scrollHeight > curr.clientHeight) {
                    scrollEl = curr;
                    break;
                }
                curr = curr.parentElement;
            }

            const sessionsMap = new Map();
            let lastCount = 0;
            let unchangedCount = 0;

            debugLog('[DOM 滚动同步] 开始启动自动向下滚动...');

            const step = () => {
                // 如果运行中途 UI 被卸载，则安全退出
                if (!document.getElementById('ds-bulk-btn')) return reject(new Error('UI 已被关闭或卸载'));

                const currentLinks = document.querySelectorAll('a[href*="/a/chat/s/"]');
                currentLinks.forEach(a => {
                    const href = a.getAttribute('href') || '';
                    const idMatch = href.match(/\/a\/chat\/s\/([\w-]+)/);
                    if (!idMatch) return;
                    const id = idMatch[1];
                    const titleEl = a.querySelector('.c08e6e93') || a.querySelector('[class*="title"]') || a.querySelector('[class*="name"]');
                    const title = (titleEl?.textContent || a.textContent || '（无标题）').trim();
                    if (!sessionsMap.has(id)) {
                        sessionsMap.set(id, { id, title, href, content: null });
                    }
                });

                onProgress(sessionsMap.size);

                if (sessionsMap.size === lastCount) {
                    unchangedCount++;
                    if (unchangedCount >= 11) { // 5.5秒无新数据认为到底
                        debugLog(`[DOM 滚动同步] 连续 5.5 秒无新数据，已触底。共提取 ${sessionsMap.size} 条历史。`);
                        resolve(Array.from(sessionsMap.values()));
                        return;
                    }
                } else {
                    if (sessionsMap.size - lastCount > 0 && debugLog) {
                        debugLog(`[DOM 滚动同步] 成功向下滚动，新增 ${sessionsMap.size - lastCount} 条记录...`);
                    }
                    unchangedCount = 0;
                    lastCount = sessionsMap.size;
                }

                // 究极复合滚动方案
                const lastLink = currentLinks[currentLinks.length - 1];
                if (lastLink) {
                    // 1. 触发原生平滑滚动
                    try { lastLink.scrollIntoView({ behavior: 'smooth', block: 'end' }); } catch(e) {}
                    // 2. 派发鼠标滚轮事件触发虚拟列表懒加载
                    try { lastLink.dispatchEvent(new WheelEvent('wheel', { deltaY: 3000, bubbles: true })); } catch(e) {}
                }

                // 3. 强制容器属性滚动与事件派发
                if (scrollEl) {
                    scrollEl.scrollTop = scrollEl.scrollHeight + 10000;
                    scrollEl.dispatchEvent(new Event('scroll', { bubbles: true }));
                } else {
                    const scrollables = document.querySelectorAll('div');
                    for (let el of scrollables) {
                        if (el.scrollHeight > el.clientHeight) {
                            el.scrollTop = el.scrollHeight + 10000;
                            el.dispatchEvent(new Event('scroll', { bubbles: true }));
                        }
                    }
                }

                setTimeout(step, 500);
            };

            step();
        });
    }



    // ==================== Promise 并发控制池 ====================
    async function promisePool(tasks, maxConcurrent, onEach) {
        const results = [];
        let index = 0;
        async function worker() {
            while (index < tasks.length) {
                const i = index++;
                const result = await onEach(tasks[i], i);
                results[i] = result;
            }
        }
        const workers = Array.from({ length: maxConcurrent }, worker);
        await Promise.all(workers);
        return results;
    }

    // ==================== 工具函数 ====================
    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ==================== UI 构建 ====================
    function buildUI() {
        // 样式注入
        const style = document.createElement('style');
        style.textContent = `
            /* dsAlert & dsConfirm Styles */
            .ds-toast-container { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); z-index: 999999; display: flex; flex-direction: column; gap: 10px; pointer-events: none; }
            .ds-toast { padding: 12px 20px; border-radius: 8px; background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); box-shadow: 0 4px 15px rgba(0,0,0,0.1); color: #1e293b; font-size: 14px; font-weight: 500; display: flex; align-items: center; gap: 8px; animation: ds-toast-in 0.3s cubic-bezier(0.34, 1.56, 0.64, 1) forwards; pointer-events: auto; border: 1px solid rgba(255,255,255,0.5); }
            .ds-toast.success { border-left: 4px solid #10b981; }
            .ds-toast.error { border-left: 4px solid #ef4444; }
            .ds-toast.warning { border-left: 4px solid #f59e0b; }
            @keyframes ds-toast-in { from { transform: translateY(-20px); opacity: 0; } to { transform: translateY(0); opacity: 1; } }
            @keyframes ds-toast-out { from { transform: translateY(0); opacity: 1; } to { transform: translateY(-20px); opacity: 0; } }
            
            .ds-modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.5); z-index: 2147483647; display: flex; justify-content: center; align-items: center; animation: ds-fadeIn 0.2s ease; pointer-events: auto; }
            .ds-modal-box { box-sizing: border-box; background: #ffffff; padding: 28px 32px; border-radius: 20px; box-shadow: 0 24px 60px rgba(0,0,0,0.3); max-width: 480px; width: 90%; animation: ds-slideUp 0.3s cubic-bezier(0.34, 1.56, 0.64, 1); pointer-events: auto; }
            .ds-modal-title { margin: 0 0 14px; font-size: 17px; font-weight: 700; color: #0f172a; }
            .ds-modal-content { font-size: 14px; color: #475569; margin-bottom: 28px; line-height: 1.7; word-break: break-word; overflow-wrap: break-word; white-space: pre-wrap; }
            .ds-modal-actions { display: flex; justify-content: flex-end; gap: 12px; }
            .ds-modal-btn { padding: 9px 22px; border-radius: 10px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: all 0.2s; pointer-events: auto; }
            .ds-modal-cancel { background: #f1f5f9; color: #475569; }
            .ds-modal-cancel:hover { background: #e2e8f0; color: #334155; }
            .ds-modal-confirm { background: linear-gradient(135deg, #3b82f6, #2563eb); color: #fff; box-shadow: 0 4px 14px rgba(59,130,246,0.4); }
            .ds-modal-confirm:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(59,130,246,0.5); }

            #ds-bulk-btn {
                user-select: none;
                touch-action: none;
                position: fixed;
                top: 80px;
                right: 16px;
                z-index: 99999;
                padding: 8px 16px;
                background: #ffffff;
                color: #0f172a;
                border: 1px solid #e2e8f0;
                border-radius: 20px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                box-shadow: 0 4px 14px rgba(0,0,0,0.08);
                transition: all 0.2s ease;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                letter-spacing: 0.3px;
            }
            #ds-bulk-btn:hover {
                transform: translateY(-1px);
                box-shadow: 0 6px 18px rgba(0,0,0,0.12);
                background: #f8fafc;
            }
            #ds-bulk-overlay {
                display: none;
                position: fixed;
                inset: 0;
                z-index: 100000;
                background: rgba(255,255,255,0.7);
                backdrop-filter: blur(4px);
                -webkit-backdrop-filter: blur(4px);
                animation: ds-fadeIn 0.2s ease;
            }
            @keyframes ds-fadeIn { from { opacity:0 } to { opacity:1 } }
            #ds-bulk-modal {
                position: absolute;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                width: min(1300px, 98vw);
                max-height: 90vh;
                overflow-y: auto;
                background: #ffffff;
                border: 1px solid #e2e8f0;
                border-radius: 16px;
                padding: 24px;
                box-shadow: 0 24px 60px rgba(0,0,0,0.15);
                color: #334155;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
                animation: ds-slideUp 0.25s cubic-bezier(0.34,1.56,0.64,1);
            }
            @keyframes ds-slideUp { from { transform:translate(-50%,-46%); opacity:0 } to { transform:translate(-50%,-50%); opacity:1 } }
            #ds-bulk-modal h2 {
                margin: 0 0 20px;
                font-size: 18px;
                font-weight: 700;
                color: #0f172a;
                display: flex;
                align-items: center;
                gap: 8px;
            }
            #ds-bulk-modal .ds-row {
                display: flex;
                gap: 10px;
                margin-bottom: 14px;
            }
            #ds-bulk-modal input[type=text] {
                flex: 1;
                padding: 10px 14px;
                background: #f8fafc;
                border: 1px solid #cbd5e1;
                border-radius: 10px;
                color: #1e293b;
                font-size: 14px;
                outline: none;
                transition: border-color 0.2s, box-shadow 0.2s;
            }
            #ds-bulk-modal input[type=text]:focus { border-color: #3b82f6; background: #fff; box-shadow: 0 0 0 2px rgba(59,130,246,0.1); }
            #ds-bulk-modal select {
                padding: 10px 14px;
                background: #f8fafc;
                border: 1px solid #cbd5e1;
                border-radius: 10px;
                color: #1e293b;
                font-size: 13px;
                outline: none;
                cursor: pointer;
            }
            #ds-bulk-modal select option { background: #fff; }
            .ds-btn {
                padding: 9px 18px;
                border: none;
                border-radius: 10px;
                font-size: 13px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.18s ease;
                white-space: nowrap;
            }
            .ds-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; box-shadow: none !important; }

            /* 行动区按钮分离样式 */
            .ds-group-label { width: 100%; font-size: 12px; color: #94a3b8; font-weight: 600; margin-bottom: 6px; }
            .ds-action-group { background: #f8fafc; border: 1px solid #f1f5f9; padding: 12px; border-radius: 12px; display: flex; gap: 10px; flex-wrap: wrap; margin-bottom: 16px; align-items: center; }

            .ds-multi-pane { display: flex; gap: 24px; margin-bottom: 8px; }
            .ds-pane { flex: 1; display: flex; flex-direction: column; min-width: 0; }
            .ds-pane-header { font-weight: 700; color: #1e293b; font-size: 14px; margin-bottom: 8px; padding-bottom: 8px; border-bottom: 1px solid #e2e8f0; }
            .ds-empty-msg { padding: 10px 14px; color: #94a3b8; font-size: 13px; text-align: center; }

            #ds-result-area, #ds-result-area-ai { display: flex; flex-direction: column; height: 360px; background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden; margin-bottom: 12px; }
            .ds-result-header { padding: 10px 14px; background: #f8fafc; border-bottom: 1px solid #e2e8f0; display: flex; justify-content: space-between; align-items: center; font-size: 13px; color: #475569; font-weight: 500; }
            .ds-result-header label { cursor: pointer; display: flex; align-items: center; gap: 6px; }
            .ds-result-list { flex: 1; overflow-y: auto; padding: 6px 0; }
            .ds-result-item { display: flex; align-items: center; gap: 10px; padding: 8px 14px; transition: background 0.15s; color: #334155; font-size: 13px; margin: 0; border-bottom: 1px solid #f8fafc; }
            .ds-result-item:hover { background: #f1f5f9; }
            .ds-session-cb { cursor: pointer; }
            .ds-session-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #3b82f6; text-decoration: none; cursor: pointer; }
            .ds-session-title:hover { text-decoration: underline; color: #2563eb; }
            .ds-result-item.deleted { text-decoration: line-through; opacity: 0.5; pointer-events: none; }

            .ds-btn-scan { background: #3b82f6; color: #fff; }
            .ds-btn-scan:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59,130,246,0.3); }

            .ds-btn-delete { background: #ef4444; color: #fff; }
            .ds-btn-delete:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(239,68,68,0.3); }

            .ds-btn-sync { background: #10b981; color: #fff; }
            .ds-btn-sync:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(16,185,129,0.3); }

            .ds-btn-clear { background: #ffffff; color: #475569; border: 1px solid #cbd5e1; }
            .ds-btn-clear:hover:not(:disabled) { background: #f1f5f9; }

            .ds-btn-close { background: #ffffff; color: #64748b; border: 1px solid #e2e8f0; margin-left: auto; }
            .ds-btn-close:hover { background: #f8fafc; color: #0f172a; }

            .ds-tab-btn { background:none; border:none; border-bottom:2px solid transparent; padding:8px 16px; cursor:pointer; font-size:14px; color:#64748b; font-weight:600; transition:all 0.2s; outline:none; }
            .ds-tab-btn:hover { color:#1e293b; }
            .ds-tab-btn.active { color:#3b82f6; border-bottom-color:#3b82f6; }
            .ds-tab-content { display:none; flex-direction:column; }
            .ds-tab-content.active { display:flex; }

            .ds-prompt-card { background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:12px 16px; transition:all 0.2s; }
            .ds-prompt-card.disabled { opacity:0.6; background:#f1f5f9; }
            .ds-prompt-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
            .ds-prompt-textarea { width:100%; box-sizing:border-box; height:80px; padding:10px; border-radius:8px; border:1px solid #cbd5e1; outline:none; font-family:inherit; font-size:13px; resize:vertical; }
            .ds-prompt-textarea:focus { border-color:#3b82f6; }

            #ds-status { margin: 0 0 8px; font-size: 13px; color: #64748b; min-height: 20px; font-weight: 500; }

            .ds-sidebar {
                    display: flex; gap: 8px; border-bottom: 1px solid #e2e8f0; margin-bottom: 20px;
                }
                .ds-tab-btn {
                    background: none; border: none; border-bottom: 2px solid transparent; padding: 8px 16px; cursor: pointer; font-size: 14px; color: #64748b; font-weight: 600; transition: all 0.2s; outline: none;
                }
                .ds-tab-btn:hover { color: #1e293b; }
                .ds-tab-btn.active { color: #3b82f6; border-bottom-color: #3b82f6; }

            #ds-debug-wrap { margin-top: 12px; border-top: 1px solid #e2e8f0; padding-top: 10px; }
            #ds-debug-wrap summary { cursor: pointer; font-size: 13px; color: #64748b; user-select: none; outline: none; font-weight: 500; }
            #ds-debug-log {
                width: 100%; height: 140px; background: #f8fafc; border: 1px solid #e2e8f0;
                border-radius: 6px; color: #475569; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; padding: 10px;
                overflow-y: auto; margin-top: 8px; white-space: pre-wrap; word-break: break-all;
            }
        `;
        document.head.appendChild(style);

        // 浮动入口按钮
        const triggerBtn = document.createElement('button');
        triggerBtn.id = 'ds-bulk-btn';
        triggerBtn.textContent = 'DS Enhance Max';

        // 遮罩层 + 弹窗
        const overlay = document.createElement('div');
        overlay.id = 'ds-bulk-overlay';
        overlay.addEventListener('click', (e) => e.stopPropagation());

        overlay.innerHTML = `
            <div id="ds-bulk-modal">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                    <h2 style="margin:0; font-size:18px; font-weight:700; color:#0f172a;">DS Enhance Max <span style="font-size:12px; font-weight:normal; color:#10b981; background:#ecfdf5; padding:2px 8px; border-radius:12px; margin-left:8px;">AI 智能增强全能版</span></h2>
                    <button class="ds-btn ds-btn-close" id="ds-close-btn" style="padding:6px 12px; margin:0;">关闭控制台</button>
                </div>

                <div id="ds-tabs" style="display:flex; gap:8px; border-bottom:1px solid #e2e8f0; margin-bottom:20px;">
                    <button class="ds-tab-btn active" data-tab="data">数据与检索中心 (AI)</button>
                    <button class="ds-tab-btn" data-tab="prompt">自定义提示词引擎</button>
                    <button class="ds-tab-btn" data-tab="export">批量导出与 Fork</button>
                    <button class="ds-tab-btn" data-tab="rename">整理与分类 (AI)</button>
                    <button class="ds-tab-btn" data-tab="ai">大模型神经中枢</button>
                    <button class="ds-tab-btn" data-tab="about" style="margin-left:auto; color:#8b5cf6;">关于开发者</button>
                </div>

                <!-- Tab 1: 数据与检索 -->
                <div id="ds-tab-data" class="ds-tab-content active">
                    <div class="ds-multi-pane">
                        <!-- 左侧：本地缓存 -->
                        <div id="ds-local-pane" class="ds-pane">
                            <div class="ds-pane-header">① 本地历史记录基准 (极速)</div>
                            <div class="ds-action-group" style="border:none; padding:8px 0; background:transparent;">
                                <button class="ds-btn ds-btn-sync" id="ds-sync-btn">同步所有历史</button>
                                <button class="ds-btn ds-btn-clear" id="ds-clear-btn" style="padding:9px 12px;">清空</button>
                                <span id="ds-status" style="margin-left:auto; font-size:12px; align-self:center;">等待操作...</span>
                            </div>
                            <div class="ds-action-group" style="border:none; padding:0 0 8px 0; background:transparent;">
                                <input type="text" id="ds-keyword" placeholder="搜索标题..." style="flex:1;" />
                                <button class="ds-btn ds-btn-scan" id="ds-filter-btn">过滤</button>
                            </div>

                            <div class="ds-advanced-selection-bar" style="background:#f8fafc; border:1px dashed #cbd5e1; border-radius:8px; padding:10px; margin-top:4px; display:flex; flex-direction:column; gap:8px;">
                                        <div style="display:flex; justify-content:space-between; align-items:center;">
                                            <span style="font-size:12px; font-weight:600; color:#475569;">快捷选择面板 (按标签)</span>
                                            <div style="display:flex; gap:6px;">
                                                <button class="ds-btn" id="ds-select-invert-btn" style="padding:4px 8px; font-size:11px; background:#fff; border:1px solid #cbd5e1; color:#475569; cursor:pointer; border-radius:4px;">反选</button>
                                            </div>
                                        </div>
                                        <div id="ds-tag-chips-container" style="display:flex; flex-wrap:wrap; gap:6px; min-height:24px; max-height:160px; overflow-y:auto; padding-bottom:4px; align-content:flex-start;"></div>
                                        <div style="font-size:10px; color:#94a3b8;">* 首次点击标签将自动清空其它勾选，后续点击支持叠加多选</div>
                                    </div>

                            <div id="ds-progress-wrap" style="margin-top:0;">
                                <div id="ds-progress-bar"></div>
                            </div>

                            <div id="ds-result-area">
                                <div class="ds-result-header" style="flex-direction: column; align-items: stretch; gap: 8px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center;">
                                        <label><input type="checkbox" id="ds-select-all" checked> 全选当前列表</label>
                                        <span id="ds-result-count">缓存: 0 条</span>
                                    </div>
                                </div>
                                <div class="ds-result-list" id="ds-result-list">
                                    <div class="ds-empty-msg">请点击上方「同步所有历史」获取过滤与隔离基准</div>
                                </div>
                            </div>
                        </div>

                        <!-- 第三栏：大模型语义检索 -->
                        <div id="ds-ai-pane" class="ds-pane">
                            <div class="ds-pane-header" style="display:flex; justify-content:space-between;">
                                <span>② 全能会话管家</span>
                                <span style="font-size:12px; font-weight:normal; color:#10b981;">需在「大模型神经中枢」配置模型</span>
                            </div>
                            <div id="ds-ai-search-hint" style="font-size:12px; color:#f59e0b; background:#fffbeb; border:1px solid #fde68a; border-radius:8px; padding:8px 12px; margin-bottom:8px; display:none;">
                                ⚠️ 请先在「① 本地历史记录基准」中同步历史数据，AI 才有内容可检索。
                            </div>
                            <div class="ds-action-group" style="border:none; padding:8px 0 4px 0; background:transparent;">
                                <input type="text" id="ds-ai-search-keyword" placeholder="可以试着说：找出你认为可能成为黑历史的对话..." style="flex:1;" />
                                <button class="ds-btn ds-btn-sync" id="ds-ai-search-btn" style="background:linear-gradient(90deg, #10b981, #059669);">下令</button>
                                <button class="ds-btn" id="ds-ai-abort-btn" style="display:none; background:#ef4444; color:#fff; padding:9px 14px;">中止</button>
                            </div>

                            <div id="ds-progress-wrap-ai" style="height:6px; background:#f1f5f9; border-radius:3px; margin-bottom:14px; overflow:hidden; margin-top:12px;">
                                <div id="ds-progress-bar-ai" style="height:100%; width:0%; background:linear-gradient(90deg, #10b981, #34d399); transition:width 0.3s ease;"></div>
                            </div>

                            <div id="ds-result-area-ai">
                                <div class="ds-result-header" style="flex-direction: column; align-items: stretch; gap: 8px;">
                                    <div style="display:flex; justify-content:space-between; align-items:center;">
                                        <label><input type="checkbox" id="ds-select-all-ai" checked> 全选当前列表</label>
                                        <div>
                                            <button class="ds-btn ds-btn-sync" id="ds-ai-bulk-tag-btn" style="padding:2px 8px; font-size:11px; margin-right:10px;">🏷️ 批量设置标签</button>
                                            <span id="ds-result-count-ai">AI 筛选出: 0 条</span>
                                        </div>
                                    </div>
                                </div>
                                <div class="ds-result-list" id="ds-result-list-ai">
                                    <div class="ds-empty-msg">输入语义需求并点击，AI 将为您精准勾选</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div style="display:flex; justify-content:space-between; align-items:center; border-top:1px solid #e2e8f0; padding-top:16px;">
                        <span style="font-size:12px; color:#64748b;">💡 提示：点击会话标题可直接在新标签页打开。左右两侧勾选的会话会自动去重。</span>
                        <div style="display:flex; gap:10px;">
                            <button class="ds-btn ds-btn-delete" id="ds-delete-btn" disabled>销毁所选会话</button>
                        </div>
                    </div>

                    <details id="ds-debug-wrap">
                        <summary>详细诊断日志 (点击展开查看原始数据抓取情况)</summary>
                        <div id="ds-debug-log">等待操作...</div>
                    </details>
                </div>

                <!-- Tab 2: 自定义提示词 -->
                <div id="ds-tab-prompt" class="ds-tab-content">
                    <div style="color:#64748b; font-size:13px; margin-bottom:12px; line-height:1.6;">
                        <strong style="color:#334155;">在底层网络通道中悄无声息地注入您的私人系统指令。</strong><br>
                        当您发送消息时，脚本会在不污染屏幕聊天记录的情况下，自动将此处启用的指令贴附在消息尾部。<br>
                        <span style="color:#3b82f6;">您也可以直接在原生网页上的输入框上方找到【指令选择】按钮，进行快捷开关。</span>
                    </div>
                    <div class="ds-action-group" style="display:flex; gap:10px; margin-bottom:16px;">
                        <input type="text" id="ds-prompt-name" placeholder="起个名字，如：专业程序员、英语翻译官..." style="flex:1;">
                        <button class="ds-btn ds-btn-sync" id="ds-prompt-add-btn">新增提示词</button>
                        <button class="ds-btn" id="ds-prompt-preset-btn" style="background:#8b5cf6; color:#fff; border:none;">载入 10 款顶级专家预设</button>
                    </div>
                    <div id="ds-prompt-list" style="display:flex; flex-direction:column; gap:10px; max-height:450px; overflow-y:auto; padding-right:8px;">
                        <!-- JS 动态渲染 Prompt Card -->
                    </div>
                </div>

                <!-- Tab 3: 导出与 Fork -->
                <div id="ds-tab-export" class="ds-tab-content">
                    <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px;">
                        <div>
                            <h3 style="margin: 0; font-size: 16px; color: #0f172a; font-weight: 700;">📦 数据资产管理中枢</h3>
                            <div style="font-size: 12px; color: #64748b; margin-top: 4px;">高可靠性数据导出与环境隔离 (Fork) 分流机制</div>
                        </div>
                        <div style="background: #eff6ff; padding: 6px 14px; border-radius: 20px; border: 1px solid #bfdbfe;">
                            <span id="ds-export-count" style="font-size: 13px; font-weight: 600; color: #2563eb;">当前已选中资产: 0 项</span>
                        </div>
                    </div>

                    <div style="display: flex; gap: 20px;">
                        <!-- 导出卡片 -->
                        <div style="flex: 1; background: linear-gradient(145deg, #ffffff, #f8fafc); border: 1px solid #e2e8f0; border-radius: 16px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02); position: relative; overflow: hidden;">
                            <div style="position: absolute; top: -10px; right: -10px; font-size: 80px; opacity: 0.03; transform: rotate(15deg);">⬇️</div>
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <div style="width: 32px; height: 32px; border-radius: 8px; background: #ecfdf5; display: flex; align-items: center; justify-content: center; font-size: 16px;">📑</div>
                                <span style="font-size: 15px; font-weight: 700; color: #1e293b;">最高精度数据导出</span>
                            </div>
                            <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin-bottom: 20px;">将选中会话的全部上下文连贯地保存至本地。适用于训练集构造、长文存档、以及知识图谱的冷备份。</p>

                            <div style="display: flex; flex-direction: column; gap: 12px; position:relative; z-index:1;">
                                <div>
                                    <label style="font-size: 11px; font-weight: 600; color: #475569; display: block; margin-bottom: 4px;">选择封装格式</label>
                                    <select id="ds-export-fmt" style="width: 100%; padding: 8px 12px; border: 1px solid #cbd5e1; border-radius: 8px; outline: none; font-size: 13px; background: #fff; cursor: pointer;">
                                        <option value="md">Markdown (.md) - 适合阅读与排版</option>
                                        <option value="json">JSON (.json) - 适合程序解析开发</option>
                                    </select>
                                </div>
                                <button class="ds-btn" id="ds-export-btn" style="width: 100%; padding: 10px; background: #10b981; color: #fff; border-radius: 8px; font-weight: 600; margin-top: 4px; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(16,185,129,0.2);">
                                    🚀 执行极速导出 (应用于已选会话)
                                </button>
                                <button class="ds-btn" id="ds-export-abort-btn" style="display:none; width: 100%; padding: 10px; background: #ef4444; color: #fff; border-radius: 8px; font-weight: 600; margin-top: 4px; border: none; cursor: pointer;">
                                    终止导出
                                </button>
                            </div>
                        </div>

                        <!-- Fork卡片 -->
                        <div style="flex: 1; background: linear-gradient(145deg, #ffffff, #faf5ff); border: 1px solid #e9d5ff; border-radius: 16px; padding: 20px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.02); position: relative; overflow: hidden;">
                            <div style="position: absolute; top: -10px; right: -10px; font-size: 80px; opacity: 0.03; transform: rotate(-15deg);">🧬</div>
                            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 12px;">
                                <div style="width: 32px; height: 32px; border-radius: 8px; background: #f3e8ff; display: flex; align-items: center; justify-content: center; font-size: 16px;">🧬</div>
                                <span style="font-size: 15px; font-weight: 700; color: #6b21a8;">平行宇宙分流 (Fork)</span>
                            </div>
                            <p style="font-size: 12px; color: #64748b; line-height: 1.6; margin-bottom: 20px;">调用原生接口克隆选中的会话。可在不污染原始对话树的前提下，开辟平行分支进行发散性的二次追问。</p>

                            <div style="display: flex; flex-direction: column; gap: 12px; margin-top: auto; justify-content: flex-end; height: calc(100% - 95px); position:relative; z-index:1;">
                                <div style="padding: 8px 12px; background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; font-size: 11px; color: #b45309; line-height:1.4;">
                                    ⚠️ Fork 机制基于官方 Share API 构建，请勿极速高频点击以防风控。
                                </div>
                                <button class="ds-btn" id="ds-fork-btn" style="width: 100%; padding: 10px; background: #8b5cf6; color: #fff; border-radius: 8px; font-weight: 600; margin-top: 4px; border: none; cursor: pointer; transition: all 0.2s; box-shadow: 0 2px 4px rgba(139,92,246,0.2);">
                                    ✨ 开启平行宇宙克隆 (应用于已选会话)
                                </button>
                                <button class="ds-btn" id="ds-fork-abort-btn" style="display:none; width: 100%; padding: 10px; background: #ef4444; color: #fff; border-radius: 8px; font-weight: 600; margin-top: 4px; border: none; cursor: pointer;">
                                    终止克隆
                                </button>
                            </div>
                        </div>
                    </div>

                    <div id="ds-export-status" style="margin-top: 16px; font-size: 13px; color: #475569; padding: 12px 16px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; display: none; align-items: center; gap: 8px;"></div>
                </div>

                <!-- Tab 4: 整理与分类 -->
                <div id="ds-tab-rename" class="ds-tab-content">
                    <div style="color:#64748b; font-size:13px; margin-bottom:16px; line-height:1.6;">
                        对 <strong style="color:#334155;">数据与检索中心</strong> 中勾选的会话进行批量重命名或标签分类。支持结合大模型进行自动归类。
                    </div>
                    <div class="ds-pane-header" style="margin-top:10px;">🏷️ 批量重命名</div>
                    <div class="ds-action-group" style="display:flex; gap:10px; margin-bottom:16px; align-items:center;">
                        <input type="text" id="ds-rename-prefix" placeholder="添加前缀 (如: [工作])" style="flex:1;">
                        <input type="text" id="ds-rename-suffix" placeholder="添加后缀 (如: -已归档)" style="flex:1;">
                        <button class="ds-btn ds-btn-scan" id="ds-rename-btn">🏷️ 执行批量重命名 (应用于已选会话)</button>
                    </div>
                    <div class="ds-pane-header" style="margin-top:10px;">手动批量打标 (应用于当前所有勾选的会话)</div>
                    <div style="background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:12px; margin-bottom:12px;">
                        <div style="display:flex; gap:10px; margin-bottom:8px;">
                            <input type="text" id="ds-bulk-tag-name" placeholder="标签名称 (例如: 优秀回答)" style="flex:2;">
                            <select id="ds-bulk-tag-color" style="flex:1; padding:0 8px; border-radius:4px; border:1px solid #cbd5e1;">
                                <option value="#3b82f6" style="color:#3b82f6;">蓝色</option>
                                <option value="#10b981" style="color:#10b981;">绿色</option>
                                <option value="#f59e0b" style="color:#f59e0b;">橙色</option>
                                <option value="#ef4444" style="color:#ef4444;">红色</option>
                                <option value="#8b5cf6" style="color:#8b5cf6;">紫色</option>
                            </select>
                            <button class="ds-btn ds-btn-scan" id="ds-bulk-tag-btn" style="padding:0 12px; height:auto;">执行批量打标</button>
                        </div>
                        <div style="margin-top:12px; padding-top:12px; border-top:1px solid #e2e8f0;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                                <span style="font-size:12px; font-weight:600; color:#475569;">全局标签组管理</span>
                                <div style="display:flex; gap:8px;">
                                    <select id="ds-tag-sort-select" style="padding:2px 6px; font-size:11px; border:1px solid #cbd5e1; border-radius:4px; outline:none; background:#fff;">
                                        <option value="time">按时间排序</option>
                                        <option value="az">按 A-Z 排序</option>
                                        <option value="color">按颜色排序</option>
                                    </select>
                                    <select id="ds-danger-wipe-select" style="padding:2px 6px; font-size:11px; border:1px solid #fca5a5; border-radius:4px; outline:none; background:#fef2f2; color:#ef4444;">
                                        <option value="none">-- 危险清理操作 --</option>
                                        <option value="global">清空 [调色盘] 标签配置模板</option>
                                        <option value="all_sessions">擦除 [所有会话] 已打的标签</option>
                                        <option value="selected_sessions">擦除 [选中会话] 已打的标签</option>
                                    </select>
                                    <button class="ds-btn ds-btn-close" id="ds-danger-wipe-btn" style="padding:2px 8px; font-size:11px; color:#fff; border-color:#ef4444; background:#ef4444;">执行</button>
                                </div>
                            </div>
                            <div id="ds-global-tags-pool" style="display:flex; gap:6px; flex-wrap:wrap; max-height:160px; min-height:60px; overflow-y:auto; padding-bottom:4px; align-content: flex-start;">
                                <!-- 标签组复用与管理 -->
                            </div>
                        </div>
                    </div>
                    <div class="ds-pane-header" style="margin-top:10px;">智能书签与分类规则 (本地化引擎)</div>
                    <div style="font-size:12px; color:#64748b; margin-bottom:12px;">设置本地关键字规则。点击“运行规则”时，将自动给标题包含指定文本的会话打上彩色标签。条件完全本地执行，不会调用 AI。</div>

                    <div style="background:#f1f5f9; border:1px solid #e2e8f0; border-radius:8px; padding:12px; margin-bottom:12px;">
                        <div style="display:flex; gap:10px; margin-bottom:8px;">
                            <input type="text" id="ds-rule-keyword" placeholder="输入匹配文本 (例如: 总结)" style="flex:2;">
                            <select id="ds-rule-color" style="flex:1; padding:0 8px; border-radius:4px; border:1px solid #cbd5e1;">
                                <option value="#3b82f6" style="color:#3b82f6;">蓝色标签</option>
                                <option value="#10b981" style="color:#10b981;">绿色标签</option>
                                <option value="#f59e0b" style="color:#f59e0b;">橙色标签</option>
                                <option value="#ef4444" style="color:#ef4444;">红色标签</option>
                                <option value="#8b5cf6" style="color:#8b5cf6;">紫色标签</option>
                            </select>
                            <input type="text" id="ds-rule-tagname" placeholder="标签名称 (例如: 摘要)" style="flex:1;">
                            <button class="ds-btn ds-btn-sync" id="ds-rule-add-btn" style="padding:0 12px; height:auto;">+ 添加规则</button>
                        </div>
                        <div id="ds-rules-list" style="display:flex; flex-direction:column; gap:6px; max-height:120px; overflow-y:auto;">
                            <!-- Rules will be injected here -->
                        </div>
                    </div>

                    <div class="ds-action-group" style="display:flex; gap:10px; align-items:center;">
                        <button class="ds-btn ds-btn-sync" id="ds-rule-run-btn" style="background:#10b981;">运行本地规则自动打标</button>
                        <span style="font-size:12px; color:#64748b; margin-left:auto;">或让 AI 帮您批量打标 </span>
                        <button class="ds-btn ds-btn-sync" id="ds-ai-categorize-btn" style="background:linear-gradient(135deg, #3b82f6, #6366f1); box-shadow:0 4px 14px rgba(59,130,246,0.3); border:none; transition:all 0.3s;">AI 全能整理 (应用于已选会话)</button>
                        <button class="ds-btn" id="ds-ai-categorize-abort-btn" style="display:none; background:#ef4444; color:#fff; padding:9px 14px;">中止</button>
                    </div>

                    <!-- AI 分类预览区 -->
                    <div id="ds-progress-wrap-ai-plan" style="margin-top:12px; margin-bottom:0px; display:none;">
                        <div id="ds-progress-status-ai-plan" style="transition: opacity 0.15s ease;" style="font-size:11px; color:#64748b; margin-bottom:6px; font-family:monospace; font-weight:600;">正在启动 AI 神经中枢...</div>
                        <div style="height:6px; background:#f1f5f9; border-radius:3px; overflow:hidden;">
                            <div id="ds-progress-bar-ai-plan" style="height:100%; width:0%; background:linear-gradient(90deg, #3b82f6, #6366f1); box-shadow: 0 0 10px rgba(59,130,246,0.5); transition:width 0.3s ease;"></div>
                        </div>
                    </div>
                    <div id="ds-ai-categorize-preview" style="display:none; margin-top:12px; background:#f8fafc; border:1px solid #e2e8f0; border-radius:8px; padding:12px;">
                        <div style="font-size:13px; font-weight:600; color:#1e293b; margin-bottom:8px;">AI 整理计划预览</div>
                        <div id="ds-ai-snarky-box" style="margin-bottom:12px; font-size:12px; color:#6366f1; background:#eef2ff; padding:8px 12px; border-radius:6px; border-left:3px solid #6366f1; font-style:italic; display:none;"></div>
                        <div id="ds-ai-preview-list" style="max-height:200px; overflow-y:auto; font-size:12px; color:#475569; display:flex; flex-direction:column; gap:4px; margin-bottom:12px; border:1px solid #cbd5e1; padding:6px; border-radius:4px; background:#fff;"></div>
                        <div style="display:flex; justify-content:flex-end; gap:8px;">
                            <button class="ds-btn ds-btn-close" id="ds-ai-cancel-plan-btn">取消</button>
                            <button class="ds-btn ds-btn-sync" id="ds-ai-execute-plan-btn" style="background:#10b981;">确认执行打标</button>
                        </div>
                    </div>

                    <div id="ds-rename-status" style="font-size:13px; color:#64748b; background:#f8fafc; padding:12px; border-radius:8px; border:1px solid #e2e8f0; display:none; margin-top:12px;"></div>
                </div>

                <!-- Tab 5: 大模型神经中枢 -->
                <div id="ds-tab-ai" class="ds-tab-content">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                        <div style="color:#64748b; font-size:13px; line-height:1.6; max-width:80%;">
                            在此配置外部 OpenAI 兼容的 API。您可添加多个模型，在需要时一键切换。<br>API 密钥仅保存在您的浏览器本地，绝对安全。
                        </div>
                        <button class="ds-btn" id="ds-ai-add-model-btn" style="background:#fff; color:#3b82f6; border:1px solid #bfdbfe; font-weight:600; padding:6px 14px; border-radius:20px; box-shadow:0 1px 2px rgba(0,0,0,0.05);">+ 添加模型</button>
                    </div>

                    <div id="ds-ai-models-list" style="display:flex; flex-direction:column; gap:12px; max-height:400px; overflow-y:auto; padding-right:8px; margin-bottom:16px;">
                        <!-- AI Model Cards dynamically generated here -->
                    </div>
                    <!-- Add/Edit Model Modal (Inline) -->
                    <div id="ds-ai-model-form-wrap" style="display:none; background:#f8fafc; border:1px solid #e2e8f0; border-radius:12px; padding:16px; margin-bottom:16px; position:relative;">
                        <h4 id="ds-ai-form-title" style="margin:0 0 12px 0; font-size:14px; color:#1e293b;">新增模型配置</h4>
                        <input type="hidden" id="ds-ai-form-id">

                        <div class="ds-row" style="flex-direction:column; gap:4px; margin-bottom:10px;">
                            <label style="font-size:11px; font-weight:600; color:#475569;">配置别名 (方便记忆) / 服务商预设</label>
                            <div style="display:flex; gap:8px;">
                                <input type="text" id="ds-ai-form-name" placeholder="例如: 硅基流动 DeepSeek" style="flex:1; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:13px;">
                                <select id="ds-ai-preset-select" style="width:140px; padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; background:#fff; outline:none; font-size:12px; color:#1e293b;">
                                    <option value="">快速填入模板...</option>
                                    <option value="deepseek">DeepSeek 官方</option>
                                    <option value="openai">OpenAI</option>
                                    <option value="gemini">Google Gemini</option>
                                    <option value="claude">Anthropic Claude</option>
                                    <option value="kimi">Moonshot Kimi</option>
                                    <option value="siliconflow">硅基流动</option>
                                    <option value="dashscope">阿里云百炼</option>
                                </select>
                            </div>
                        </div>

                        <div class="ds-row" style="flex-direction:column; gap:4px; margin-bottom:10px;">
                            <label style="font-size:11px; font-weight:600; color:#475569;">API Base URL (需包含 /chat/completions)</label>
                            <input type="text" id="ds-ai-url" placeholder="例如: https://api.deepseek.com/v1/chat/completions" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:13px; width:100%; box-sizing:border-box;">
                        </div>

                        <div style="display:flex; gap:12px; margin-bottom:4px;">
                            <div class="ds-row" style="flex-direction:column; gap:4px; flex:2;">
                                <label style="font-size:11px; font-weight:600; color:#475569;">API Key</label>
                                <input type="password" id="ds-ai-key" placeholder="sk-..." style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:13px; width:100%; box-sizing:border-box;">
                            </div>
                            <div class="ds-row" style="flex-direction:column; gap:4px; flex:1;">
                                <label style="font-size:11px; font-weight:600; color:#475569;">调用模型 (Model)</label>
                                <input type="text" id="ds-ai-model" placeholder="例如: deepseek-chat" style="padding:6px 10px; border:1px solid #cbd5e1; border-radius:6px; outline:none; font-size:13px; width:100%; box-sizing:border-box;">
                            </div>
                        </div>
                        <div style="margin-bottom:16px;">
                            <button class="ds-btn ds-btn-clear" id="ds-ai-fetch-models-btn" style="padding:4px 10px; font-size:11px; background:#e2e8f0; color:#475569; border-radius:4px; border:none; margin-top:4px;">自动获取可用模型列表</button>
                            <div id="ds-fetched-models-wrap" style="display:none; margin-top:8px; padding:10px; background:#fff; border:1px solid #e2e8f0; border-radius:8px;">
                                <div style="font-size:11px; color:#10b981; margin-bottom:8px;" id="ds-fetched-models-status">已加载 0 个模型。</div>
                                <div id="ds-fetched-models-list" style="display:flex; flex-wrap:wrap; gap:6px; max-height:120px; overflow-y:auto;"></div>
                            </div>
                        </div>

                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <button class="ds-btn" id="ds-ai-test-btn" style="background:#fff; color:#475569; border:1px solid #cbd5e1;">测试连接</button>
                            <div style="display:flex; gap:8px; align-items:center;">
                                <div id="ds-ai-status" style="font-size:12px; display:none; padding:4px 8px; border-radius:4px;"></div>
                                <button class="ds-btn" id="ds-ai-form-cancel" style="background:transparent; color:#64748b; border:1px solid #cbd5e1;">取消</button>
                                <button class="ds-btn ds-btn-sync" id="ds-ai-save-btn" style="background:#10b981;">保存配置</button>
                            </div>
                        </div>
                    </div>
                </div>

                <!-- Tab 6: 关于开发者 -->
                <div id="ds-tab-about" class="ds-tab-content">
                    <div style="text-align:center; padding:40px 20px;">
                        <h3 style="font-size:24px; color:#1e293b; margin-bottom:12px; font-weight:800; background:linear-gradient(90deg, #3b82f6, #8b5cf6); -webkit-background-clip:text; -webkit-text-fill-color:transparent;">DS Enhance Max</h3>
                        <p style="font-size:14px; color:#64748b; margin-bottom:30px; line-height:1.6;">突破限制的 DeepSeek 全能增强套件，专为极致效率而生。</p>
                        
                        <div style="display:inline-flex; flex-direction:column; gap:16px; align-items:center; background:#f8fafc; padding:24px 40px; border-radius:16px; border:1px solid #e2e8f0; box-shadow:0 10px 30px rgba(0,0,0,0.05);">
                            <div style="width:80px; height:80px; border-radius:50%; background:linear-gradient(135deg, #3b82f6, #8b5cf6); display:flex; justify-content:center; align-items:center; color:#fff; font-size:32px; font-weight:bold; margin-bottom:8px; box-shadow:0 8px 20px rgba(139,92,246,0.3);">T</div>
                            <div style="font-size:18px; font-weight:700; color:#0f172a;">开发者: TRYuuu</div>
                            
                            <a href="https://github.com/TRYuuu233/DS-Enhance-Max" target="_blank" style="display:flex; align-items:center; gap:8px; text-decoration:none; color:#475569; font-size:14px; padding:8px 16px; background:#fff; border:1px solid #cbd5e1; border-radius:20px; transition:all 0.2s; box-shadow:0 2px 4px rgba(0,0,0,0.02);" onmouseover="this.style.borderColor='#3b82f6'; this.style.color='#3b82f6'" onmouseout="this.style.borderColor='#cbd5e1'; this.style.color='#475569'">
                                <svg height="16" width="16" viewBox="0 0 16 16" fill="currentColor"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"></path></svg>
                                GitHub 项目主页
                            </a>
                            
                            <a href="https://tryuuu.netlify.app/" target="_blank" style="display:flex; align-items:center; gap:8px; text-decoration:none; color:#fff; font-size:14px; padding:10px 24px; background:linear-gradient(90deg, #10b981, #059669); border-radius:24px; font-weight:600; margin-top:8px; transition:all 0.2s; box-shadow:0 4px 12px rgba(16,185,129,0.3);" onmouseover="this.style.transform='translateY(-2px)'; this.style.boxShadow='0 6px 16px rgba(16,185,129,0.4)'" onmouseout="this.style.transform='translateY(0)'; this.style.boxShadow='0 4px 12px rgba(16,185,129,0.3)'">
                                联系我 && 支持打赏
                            </a>
                        </div>
                    </div>
                </div>

            </div>
        `;

        document.body.appendChild(triggerBtn);
        document.body.appendChild(overlay);

        // 元素引用
        const modal = overlay.querySelector('#ds-bulk-modal');
        const keywordInput = overlay.querySelector('#ds-keyword');
        const syncBtn = overlay.querySelector('#ds-sync-btn');
        const clearBtn = overlay.querySelector('#ds-clear-btn');
        const filterBtn = overlay.querySelector('#ds-filter-btn');
        const deleteBtn = overlay.querySelector('#ds-delete-btn');
        const closeBtn = overlay.querySelector('#ds-close-btn');
        const statusEl = overlay.querySelector('#ds-status');
        const progressBar = overlay.querySelector('#ds-progress-bar');
        const resultArea = overlay.querySelector('#ds-result-area');
        const resultList = overlay.querySelector('#ds-result-list');
        const selectAllCb = overlay.querySelector('#ds-select-all');
        const resultCount = overlay.querySelector('#ds-result-count');


        const debugLogEl = overlay.querySelector('#ds-debug-log');

        window.__dsSyncTagUI = () => {
            try { window.__dsLocalTags = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(e){}
            try { window.__dsGlobalTags = JSON.parse(localStorage.getItem('ds_global_tags') || '[]'); } catch(e){}
            
            if (typeof window.__dsPopulateSelectByTag === 'function') window.__dsPopulateSelectByTag();
            
            // 实时刷新列表，让会话上的标签视觉立刻更新
            if (typeof matchedSessions !== 'undefined' && matchedSessions.length > 0 && resultList) {
                renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
            }
        };

        // 状态缓存区 (结合 localStorage)
        let initialCache = [];
        try {
            const stored = localStorage.getItem('ds_bulk_sessions');
            if (stored) {
                initialCache = JSON.parse(stored);
            }
        } catch(e) {}

        window.__dsCachedSessions = window.__dsCachedSessions || initialCache;
        let matchedSessions = [];
        let isRunning = false;

        const saveCache = () => {
            try { localStorage.setItem('ds_bulk_sessions', JSON.stringify(window.__dsCachedSessions)); } catch(e) {}
        };

        // 工具方法
        const setStatus = (text) => { statusEl.textContent = text; };
        const setProgress = (val) => { progressBar.style.width = Math.min(100, val) + '%'; };
        const appendDebugLog = (msg) => {
            if (!debugLogEl) return;
            const time = new Date().toLocaleTimeString();
            debugLogEl.textContent += `\n[${time}] ${msg}`;
            debugLogEl.scrollTop = debugLogEl.scrollHeight;
        };
        const clearDebugLog = () => { if (debugLogEl) debugLogEl.textContent = '--- 诊断日志开始 ---'; };
        const lockUI = (lock) => {
            isRunning = lock;
            syncBtn.disabled = lock;
            clearBtn.disabled = lock;
            filterBtn.disabled = lock;
            deleteBtn.disabled = lock || (overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)').length === 0);
            keywordInput.disabled = lock;
            closeBtn.disabled = lock;
        };

        // 打开/关闭
        
        let isDraggingBtn = false;
        let startX, startY, startLeft, startTop;

        try {
            const pos = JSON.parse(localStorage.getItem('ds_btn_pos'));
            if (pos && typeof pos.top === 'number' && typeof pos.left === 'number') {
                triggerBtn.style.top = pos.top + 'px';
                triggerBtn.style.left = pos.left + 'px';
                triggerBtn.style.right = 'auto'; 
            }
        } catch(e){}

        triggerBtn.addEventListener('mousedown', (e) => {
            if (e.button !== 0) return; // Only left click
            isDraggingBtn = false;
            startX = e.clientX;
            startY = e.clientY;
            const rect = triggerBtn.getBoundingClientRect();
            startLeft = rect.left;
            startTop = rect.top;
            
            // Immediately apply fixed px left/top and remove right pinning for smooth dragging
            triggerBtn.style.right = 'auto'; 
            triggerBtn.style.left = startLeft + 'px';
            triggerBtn.style.top = startTop + 'px';
            triggerBtn.style.transition = 'none'; // Prevent jitter when dragging
            
            const onMouseMove = (moveEvent) => {
                const dx = moveEvent.clientX - startX;
                const dy = moveEvent.clientY - startY;
                if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                    isDraggingBtn = true;
                }
                if (isDraggingBtn) {
                    let newLeft = startLeft + dx;
                    let newTop = startTop + dy;
                    
                    const maxLeft = window.innerWidth - rect.width;
                    const maxTop = window.innerHeight - rect.height;
                    newLeft = Math.max(0, Math.min(newLeft, maxLeft));
                    newTop = Math.max(0, Math.min(newTop, maxTop));
                    
                    triggerBtn.style.left = newLeft + 'px';
                    triggerBtn.style.top = newTop + 'px';
                }
            };
            
            const onMouseUp = () => {
                triggerBtn.style.transition = 'all 0.2s ease';
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
                if (isDraggingBtn) {
                    try {
                        localStorage.setItem('ds_btn_pos', JSON.stringify({
                            left: parseInt(triggerBtn.style.left),
                            top: parseInt(triggerBtn.style.top)
                        }));
                    } catch(err){}
                }
            };
            
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        triggerBtn.addEventListener('click', (e) => {
            if (isDraggingBtn) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            overlay.style.display = 'block';
            if (window.__dsCachedSessions.length > 0) {
                setStatus(`已从本地缓存加载 ${window.__dsCachedSessions.length} 条记录`);
                resultCount.textContent = `缓存: ${window.__dsCachedSessions.length} 条`;
                if (!resultList.querySelector('.ds-result-item')) {
                    matchedSessions = window.__dsCachedSessions;
                    renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
                }
            }
        });
        closeBtn.addEventListener('click', () => { if (!isRunning) overlay.style.display = 'none'; });
        overlay.addEventListener('click', (e) => { if (!isRunning && e.target === overlay) overlay.style.display = 'none'; });

        // ============ 0. 清空缓存 ============
        clearBtn.addEventListener('click', () => {
            if (window.__dsCachedSessions.length === 0) return;
            const confirmed = confirm('确定要清空本地所有已同步的会话缓存吗？');
            if (!confirmed) return;
            window.__dsCachedSessions = [];
            saveCache();
            matchedSessions = [];
            renderResultList([], resultList, resultCount, selectAllCb);
            setStatus('本地缓存已清空');
            clearDebugLog();
        });

        // ============ 1. 同步数据逻辑 ============
        syncBtn.addEventListener('click', async () => {
            setProgress(0);
            lockUI(true);
            clearDebugLog();

            try {
                setStatus('正在启动原生页面滚动引擎同步...');
                appendDebugLog(`[引擎切换] 放弃受限的 API 拉取，改用模拟真实用户的 DOM 滚动拉取...`);

                const sessions = await autoScrollSidebar((count) => {
                    setStatus(`模拟向下滚动中... 页面已刷出 ${count} 条`);
                    // 滚动没法知道总量，进度条给个滚动动画效果
                    setProgress((count % 100) || 100);
                }, appendDebugLog);

                // 将拉取到的最新列表存入全局缓存，初始化 content 为 null 以备懒加载
                window.__dsCachedSessions = sessions;
                saveCache();

                if (window.__dsCachedSessions.length === 0) {
                    setStatus('⚠️ 同步完成，但获取到的会话数为 0。请确保左侧边栏已展开。');
                } else {
                    setStatus(`同步完成！共 ${window.__dsCachedSessions.length} 条会话缓存至内存。`);
                }

                // 渲染全部数据到列表
                matchedSessions = window.__dsCachedSessions;
                renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
                setProgress(100);
            } catch (err) {
                setStatus(`❌ 同步中断：${err.message}`);
                appendDebugLog(`[错误] ${err.stack || err.message}`);
            } finally {
                lockUI(false);
            }
        });

        // ============ 2. 过滤检索逻辑 ============
        filterBtn.addEventListener('click', async () => {
            // 开始过滤时自动清空之前所有隐藏或可见的勾选
            document.querySelectorAll('#ds-local-pane .ds-session-cb:checked').forEach(cb => cb.checked = false);
            updateSelectAllState();
            const keyword = keywordInput.value.trim();
            if (!keyword) { setStatus('⚠️ 请先输入关键词'); return; }

            setProgress(0);
            lockUI(true);
            deleteBtn.disabled = true;

            const kw = keyword.toLowerCase();
            matchedSessions = [];

            try {
                if (!window.__dsCachedSessions || window.__dsCachedSessions.length === 0) {
                    setStatus('⚠️ 请先点击上方的「同步历史会话」抓取数据，再进行搜索。');
                    lockUI(false);
                    return;
                }

                // 进行毫秒级本地过滤
                matchedSessions = window.__dsCachedSessions.filter(s => {
                    const titleMatch = (s.title || '').toLowerCase().includes(kw);
                    const sessionTags = window.__dsLocalTags[s.id] || [];
                    const tagMatch = sessionTags.some(t => t.name.toLowerCase().includes(kw));
                    return titleMatch || tagMatch;
                });
                setProgress(100);
                renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
                setStatus(`过滤完成：匹配到 ${matchedSessions.length} 条对话`);

            } catch (err) {
                setStatus(`❌ 检索出错：${err.message}`);
            } finally {
                lockUI(false);
            }
        });


        // ============ 3.5 第三栏：大模型语义检索逻辑 ============
        const aiSearchKeywordInput = overlay.querySelector('#ds-ai-search-keyword');
        const aiSearchBtn = overlay.querySelector('#ds-ai-search-btn');
        const aiAbortBtn = overlay.querySelector('#ds-ai-abort-btn');
        const aiSearchHint = overlay.querySelector('#ds-ai-search-hint');
        const progressBarAi = overlay.querySelector('#ds-progress-bar-ai');
        const resultListAi = overlay.querySelector('#ds-result-list-ai');
        const selectAllCbAi = overlay.querySelector('#ds-select-all-ai');
        const resultCountAi = overlay.querySelector('#ds-result-count-ai');
        let aiAbortController = null;

        // 打开面板时检查数据状态并显示提示
        triggerBtn.addEventListener('click', () => {
            if (!window.__dsCachedSessions || window.__dsCachedSessions.length === 0) {
                if (aiSearchHint) aiSearchHint.style.display = 'block';
            } else {
                if (aiSearchHint) aiSearchHint.style.display = 'none';
            }
        }, { passive: true });

        aiAbortBtn.addEventListener('click', () => {
            if (aiAbortController) {
                aiAbortController.abort();
                aiAbortController = null;
            }
        });

        aiSearchBtn.addEventListener('click', async () => {
            // 开始AI检索前自动清空之前所有隐藏或可见的勾选
            document.querySelectorAll('#ds-ai-pane .ds-session-cb:checked').forEach(cb => cb.checked = false);
            if (typeof updateSelectAllStateAi === 'function') updateSelectAllStateAi();
            const query = aiSearchKeywordInput.value.trim();
            if (!query) { setStatus('⚠️ 请输入你想让 AI 帮你找的自然语言描述'); return; }

            if (!window.__dsCachedSessions || window.__dsCachedSessions.length === 0) {
                aiSearchHint.style.display = 'block';
                setStatus('⚠️ 请先在左侧点击【同步所有历史】，获取本地数据后才能让 AI 帮你筛选！');
                return;
            }
            aiSearchHint.style.display = 'none';

            if (!window.__dsAiSearchWarned) {
                dsAlert('提醒：进行智能搜索将忽略左侧面板当前的选中状态，您可以在右侧出现的结果中重新勾选。', 'warning', 6000);
                window.__dsAiSearchWarned = true;
            }

            // 获取配置
            let conf = window.__dsGetActiveAIConfig ? window.__dsGetActiveAIConfig() : {};
            if (!conf.url || !conf.key || !conf.model) {
                setStatus('⚠️ 请先在 Tab 5「大模型神经中枢」面板中配置并激活好 API！');
                return;
            }

            // 显示中止按钮，隐藏搜索按钮
            aiSearchBtn.style.display = 'none';
            aiAbortBtn.style.display = '';
            lockUI(true);
            
            let fakeProgressTimerAi = null;
            if (progressBarAi) {
                progressBarAi.style.width = '0%';
                const loadingPhrases = [
                    { t: 0, progress: 5, text: '正在向神经中枢注入搜索关键词...' },
                    { t: 1, progress: 15, text: '正在组装本地全量对话切片...' },
                    { t: 3, progress: 30, text: '大模型正在高维空间进行语义匹配...' },
                    { t: 7, progress: 50, text: '数据有点多，正在过滤无关上下文...' },
                    { t: 11, progress: 65, text: '提取到了疑似目标，正在校验相关性...' },
                    { t: 15, progress: 85, text: '几近完成，正在封装 JSON 结果...' }
                ];
                let startTime = Date.now();
                let currentTargetProgress = 0;
                let curProgress = 0;
                
                setStatus(loadingPhrases[0].text);
                
                fakeProgressTimerAi = setInterval(() => {
                    const elapsed = (Date.now() - startTime) / 1000;
                    let activePhase = loadingPhrases[0];
                    for (let i = loadingPhrases.length - 1; i >= 0; i--) {
                        if (elapsed >= loadingPhrases[i].t) {
                            activePhase = loadingPhrases[i];
                            if (statusEl.textContent !== activePhase.text) {
                                statusEl.style.opacity = '0';
                                setTimeout(() => {
                                    setStatus(activePhase.text);
                                    statusEl.style.opacity = '1';
                                }, 200);
                            }
                            break;
                        }
                    }
                    currentTargetProgress = activePhase.progress;
                    curProgress += (currentTargetProgress - curProgress) * 0.08;
                    curProgress += Math.random() * 0.5;
                    if (curProgress > 95) curProgress = 95;
                    progressBarAi.style.width = curProgress + '%';
                }, 100);
            }

            const total = Math.min(window.__dsCachedSessions.length, 2000);
            

            aiAbortController = new AbortController();
            try {
                const sourceData = window.__dsCachedSessions.slice(0, 2000);
                const tagsMap = {};
                try { Object.assign(tagsMap, JSON.parse(localStorage.getItem('ds_local_tags') || '{}')); } catch(e){}
                const simplifiedList = sourceData.map(s => {
                    let item = { id: s.id, title: s.title };
                    if (s.content) item.content = s.content;
                    let stags = tagsMap[s.id];
                    if (stags && stags.length > 0) item.tags = stags.map(t => t.name);
                    return item;
                });

                const prompt = `你是一个精准的数据筛选助手。
请根据用户的需求，从下方的 JSON 数组中挑选出所有语义相关的对话记录。
用户需求："${query}"

只返回符合条件的对象的 id 组成的纯 JSON 数组，例如：["id1", "id2"]。
不要返回 markdown 代码块标记，不要返回解释性文字，只输出合法的 JSON 数组结构。

待匹配数据：
${JSON.stringify(simplifiedList)}`;

                const resp = await fetch(conf.url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${conf.key}` },
                    body: JSON.stringify({ model: conf.model, messages: [{ role: 'user', content: prompt }] }),
                    signal: aiAbortController.signal
                });

                

                if (!resp.ok) throw new Error(`HTTP ${resp.status} - ${resp.statusText}`);
                const data = await resp.json();
                let reply = data?.choices?.[0]?.message?.content || '[]';

                // 清理大模型可能输出的多余标记，增强正则提取
                const jsonMatch = reply.match(/\[[\s\S]*\]/);
                if (jsonMatch) {
                    reply = jsonMatch[0];
                } else {
                    reply = reply.replace(/^```(json)?[\n]?/i, '').replace(/[\n]?```$/i, '').trim();
                }

                let matchedIds = [];
                try {
                    matchedIds = JSON.parse(reply);
                    if (!Array.isArray(matchedIds)) throw new Error('解析结果不是数组');
                } catch(e) {
                    throw new Error('大模型未按规范输出纯 JSON 数组。尝试提取的内容: \n' + reply.substring(0, 100) + '...');
                }

                
                if (typeof fakeProgressTimerAi !== 'undefined' && fakeProgressTimerAi) clearInterval(fakeProgressTimerAi);
                if (progressBarAi) progressBarAi.style.width = '100%';

                const matchedSessions = sourceData.filter(s => matchedIds.includes(s.id));
                renderResultList(matchedSessions, resultListAi, resultCountAi, selectAllCbAi);
                setStatus(`✨ AI 筛选完成！从 ${sourceData.length} 条数据中挑出了 ${matchedSessions.length} 条匹配记录。`);

            } catch(e) {
                if (e.name === 'AbortError') {
                    setStatus('🛑 AI 检索已被用户中止。');
                } else {
                    setStatus(`❌ AI 检索失败：${e.message}`);
                }
                progressBarAi.style.width = '0%';
            } finally {
                aiAbortController = null;
                aiSearchBtn.style.display = '';
                aiAbortBtn.style.display = 'none';
                lockUI(false);
            }
        });

        // 绑定批量设置标签按钮事件 (跳转并聚焦)
        const aiBulkTagBtn = overlay.querySelector('#ds-ai-bulk-tag-btn');
        if (aiBulkTagBtn) {
            aiBulkTagBtn.addEventListener('click', () => {
                const checked = overlay.querySelectorAll('#ds-ai-pane .ds-session-cb:checked:not(:disabled)');
                if (checked.length === 0) return dsAlert('请在AI结果中勾选要整理的会话', 'warning');
                overlay.querySelector('[data-tab="rename"]').click();
                setTimeout(() => {
                    const tagInput = overlay.querySelector('#ds-bulk-tag-name');
                    if (tagInput) { tagInput.focus(); tagInput.scrollIntoView({behavior: 'smooth', block: 'center'}); }
                }, 100);
            });
        }

        // 核心渲染器，支持目标指定与新标签页跳转
        function renderResultList(sessions, listEl, countEl, cbEl) {
            countEl.textContent = `共 ${sessions.length} 条`;

            if (sessions.length === 0) {
                listEl.innerHTML = '<div class="ds-empty-msg">没有找到匹配的数据</div>';
                updateDeleteBtnState();
                return;
            }

            const MAX_RENDER = 2000;
            const renderList = sessions.slice(0, MAX_RENDER);

            let tagsMap = {};
            try { tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(e){}

            let html = renderList.map(s => {
                let snippetHtml = '';
                if (s.content) {
                    snippetHtml = `<div style="font-size:11px; color:#94a3b8; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${s.content.replace(/"/g, '&quot;')}">${s.content}</div>`;
                }

                let tagsHtml = '';
                const stags = tagsMap[s.id] || [];
                if (stags.length > 0) {
                    tagsHtml = stags.map(t => `<span style="display:inline-block; margin-right:4px; padding:2px 6px; font-size:10px; border-radius:10px; color:#fff; background:${t.color || '#3b82f6'};">${t.name}</span>`).join('');
                }
                return `
                <div class="ds-result-item" id="item-${s.id}" style="align-items:flex-start; padding-right:8px; display:flex;">
                    <input type="checkbox" class="ds-session-cb" value="${s.id}" data-title="${s.title.replace(/"/g, '&quot;')}" checked style="margin-top:3px; margin-right:8px;">
                    <div style="flex:1; min-width:0; overflow:hidden;">
                        <div style="display:flex; align-items:center;">
                            <a class="ds-session-title" style="display:block; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; flex:1;" href="/a/chat/s/${s.id}" target="_blank" title="在新标签页中预览对话详情">${tagsHtml}${s.title}</a>
                            <div class="ds-row-actions" style="display:flex; gap:6px; margin-left:8px;">
                                <button class="ds-btn ds-btn-tag" data-id="${s.id}" style="padding:2px 6px; font-size:11px; height:auto; background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; border-radius:4px;" title="设置分类标签">🏷️ 标签</button>
                                <button class="ds-btn ds-btn-fork" data-id="${s.id}" style="padding:2px 6px; font-size:11px; height:auto; background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; border-radius:4px;" title="从该对话 Fork 一份全新拷贝">🌿 Fork</button>
                            </div>
                        </div>
                        ${snippetHtml}
                    </div>
                </div>
            `}).join('');

            if (sessions.length > MAX_RENDER) {
                html += `<div style="padding: 12px 14px; color: #f59e0b; font-size: 13px; text-align: center; border-top: 1px solid #e2e8f0;">... 匹配数据达到 ${sessions.length} 条，仅展示前 ${MAX_RENDER} 条。</div>`;
            }

            listEl.innerHTML = html;

            cbEl.checked = true;
            updateDeleteBtnState();
            // 触发复选框更新钩子，使得其他面板能感知到已选数量的变化
            overlay.dispatchEvent(new Event('change'));
        }

        // 交互逻辑：复选框全选/联动
        [selectAllCb, selectAllCbAi].forEach(cb => {
            if (!cb) return;
            cb.addEventListener('change', (e) => {
                const checked = e.target.checked;
                // 仅选中当前 cb 对应 pane 内的条目
                const container = e.target.closest('.ds-result-header').nextElementSibling;
                container.querySelectorAll('.ds-session-cb:not(:disabled)').forEach(childCb => { childCb.checked = checked; });
                updateDeleteBtnState();
            });
        });

        window.__dsUpdateExportPane = () => {
            const checkedCbs = Array.from(overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)'));
            const uniqueSessions = new Map();
            checkedCbs.forEach(cb => {
                const title = cb.dataset.title || '未知会话';
                uniqueSessions.set(cb.value, { id: cb.value, title });
            });
            const items = Array.from(uniqueSessions.values());

            const exportCountLab = overlay.querySelector('#ds-export-count');
            const exportPreviewWrap = overlay.querySelector('#ds-export-preview');
            const exportPreviewList = overlay.querySelector('#ds-export-preview-list');

            if (exportCountLab) exportCountLab.textContent = `当前已选中资产: ${items.length} 项`;

            if (items.length > 0 && exportPreviewWrap && exportPreviewList) {
                exportPreviewList.innerHTML = items.map(s => `
                    <div style="display:flex; justify-content:space-between; align-items:center; background:#f8fafc; padding:8px 12px; border-radius:6px; border:1px solid #e2e8f0;">
                        <span style="overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; padding-right:10px;">${s.title}</span>
                        <span style="font-size:11px; color:#94a3b8; font-family:monospace;">${s.id.substring(0,8)}...</span>
                    </div>
                `).join('');
                exportPreviewWrap.style.display = 'block';
            } else if (exportPreviewWrap && exportPreviewList) {
                exportPreviewWrap.style.display = 'none';
                exportPreviewList.innerHTML = '';
            }
        };

        overlay.addEventListener('change', (e) => {
            if (e.target.classList.contains('ds-session-cb') || e.target.id === 'ds-select-all' || e.target.id === 'ds-select-all-ai') {
                window.__dsUpdateExportPane();
                updateDeleteBtnState();
            }
        });

        window.updateSelectAllState = () => {
            const allCbs = overlay.querySelectorAll('#ds-local-pane .ds-session-cb:not(:disabled)');
            if (allCbs.length > 0) {
                const checkedCbs = overlay.querySelectorAll('#ds-local-pane .ds-session-cb:checked:not(:disabled)');
                if (selectAllCb) {
                    selectAllCb.checked = (checkedCbs.length === allCbs.length);
                    selectAllCb.indeterminate = (checkedCbs.length > 0 && checkedCbs.length < allCbs.length);
                }
            }
            updateDeleteBtnState();
        };

        window.updateSelectAllStateAi = () => {
            const allCbs = overlay.querySelectorAll('#ds-ai-pane .ds-session-cb:not(:disabled)');
            if (allCbs.length > 0) {
                const checkedCbs = overlay.querySelectorAll('#ds-ai-pane .ds-session-cb:checked:not(:disabled)');
                if (selectAllCbAi) {
                    selectAllCbAi.checked = (checkedCbs.length === allCbs.length);
                    selectAllCbAi.indeterminate = (checkedCbs.length > 0 && checkedCbs.length < allCbs.length);
                }
            }
            updateDeleteBtnState();
        };

        overlay.addEventListener('click', async (e) => {
            // 点击 Fork 按钮
            if (e.target.classList.contains('ds-btn-fork')) {
                const sid = e.target.dataset.id;
                try {
                    e.target.disabled = true;
                    e.target.textContent = '⏳ 克隆中...';
                    const hist = await apiHistory(sid);
                    // 兼容多种响应格式
                    const msgs = hist?.data?.biz_data?.chat_messages
                               || hist?.biz_data?.chat_messages
                               || hist?.data?.chat_messages || [];
                    if (msgs.length === 0) throw new Error('该会话暂无消息可 Fork，请先与之交互后再试');
                    const mids = msgs.map(m => m.message_id);
                    const s = await apiCreateShare(sid, mids);
                    const shareId = s?.data?.biz_data?.share_id || s?.biz_data?.share_id || s?.data?.share_id;
                    if (!shareId) throw new Error('创建分享失败，未获得 share_id');
                    const f = await apiForkShare(shareId);
                    const newSid = f?.data?.biz_data?.chat_session_id || f?.biz_data?.chat_session_id || f?.data?.chat_session_id;
                    if (!newSid) throw new Error('Fork 成功但未返回新会话 ID');
                    window.open(`https://chat.deepseek.com/a/chat/s/${newSid}`, '_blank');
                    e.target.textContent = '✅ 成功';
                    setTimeout(() => { if(e.target) e.target.textContent = '🌿 Fork'; }, 2000);
                } catch(err) {
                    dsAlert('Fork 失败: ' + err.message, 'error');
                    e.target.textContent = '❌ 失败';
                    setTimeout(() => { if(e.target) e.target.textContent = '🌿 Fork'; }, 2000);
                } finally {
                    e.target.disabled = false;
                }
            }

            // 点击标签按钮 -> 展开行内浮窗管理标签
            if (e.target.classList.contains('ds-btn-tag')) {
                const sid = e.target.dataset.id;
                document.querySelectorAll('.ds-inline-tag-panel').forEach(p => p.remove());
                let tagsMap = {};
                try { tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(_){}
                const currentTags = tagsMap[sid] || [];
                const panel = document.createElement('div');
                panel.className = 'ds-inline-tag-panel';
                panel.style.cssText = 'position:fixed;z-index:2147483647;background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:14px;box-shadow:0 12px 32px rgba(0,0,0,0.15);width:280px;font-family:inherit;font-size:13px;';
                const rect = e.target.getBoundingClientRect();
                panel.style.top = Math.min(rect.bottom + 6, window.innerHeight - 200) + 'px';
                panel.style.left = Math.max(4, rect.left - 120) + 'px';

                const saveAndRefresh = () => {
                    localStorage.setItem('ds_local_tags', JSON.stringify(tagsMap));
                    // 刷新本地列表显示
                    if (window.__dsCachedSessions) renderResultList(window.__dsCachedSessions, resultList, resultCount, selectAllCb);
                };

                const renderPanel = () => {
                    const tags = tagsMap[sid] || [];
                    const tagsHtml = tags.length > 0 ? tags.map((t, i) =>
                        `<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:${t.color};color:#fff;font-size:11px;margin:2px 2px 4px 0;">
                            ${t.name}
                            <span data-del="${i}" style="cursor:pointer;opacity:0.8;font-size:13px;">×</span>
                        </span>`).join('')
                        : '<span style="color:#94a3b8;font-size:12px;">暂无标签，在下方添加</span>';

                    let gTagsHtml = '';
                    try {
                        const gTags = JSON.parse(localStorage.getItem('ds_global_tags') || '[]');
                        if (gTags.length > 0) {
                            gTagsHtml = `<div style="font-size:11px; color:#64748b; margin-top:8px; margin-bottom:4px;">从标签组快速添加：</div><div style="display:flex; flex-wrap:wrap; gap:4px; margin-bottom:8px;">` + gTags.map(t =>
                                `<span class="ds-inline-quick-tag" data-name="${t.name}" data-color="${t.color}" style="padding:2px 8px; border-radius:8px; background:#f1f5f9; color:#475569; border:1px solid #cbd5e1; font-size:10px; cursor:pointer;" onmouseover="this.style.borderColor='#3b82f6'" onmouseout="this.style.borderColor='#cbd5e1'">+ ${t.name}</span>`
                            ).join('') + `</div>`;
                        }
                    } catch(e) {}

                    panel.innerHTML = `
                        <div style="font-weight:700;color:#1e293b;margin-bottom:8px;">🏷️ 标签管理</div>
                        <div class="ds-tags-display" style="margin-bottom:10px;min-height:24px;">${tagsHtml}</div>
                        ${gTagsHtml}
                        <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">
                            <div style="display:flex;gap:4px;">
                                ${['#3b82f6','#10b981','#f59e0b','#ef4444','#8b5cf6'].map(c =>
                                    `<div data-color="${c}" style="width:18px;height:18px;border-radius:50%;background:${c};cursor:pointer;border:2px solid transparent;transition:transform 0.1s;"></div>`).join('')}
                            </div>
                        </div>
                        <div style="display:flex;gap:6px;">
                            <input id="ds-tag-name-inp" type="text" placeholder="输入标签名称..." style="flex:1;padding:6px 10px;border:1px solid #cbd5e1;border-radius:8px;font-size:12px;outline:none;">
                            <button id="ds-tag-add" style="padding:6px 12px;background:#10b981;color:#fff;border:none;border-radius:8px;font-size:12px;cursor:pointer;white-space:nowrap;">添加</button>
                        </div>
                        <div style="text-align:right;margin-top:8px;"><button id="ds-tag-close" style="padding:4px 10px;background:#f1f5f9;border:1px solid #e2e8f0;border-radius:6px;font-size:11px;cursor:pointer;">关闭</button></div>
                    `;

                    let selectedColor = '#3b82f6';
                    panel.querySelectorAll('[data-color]').forEach(dot => {
                        dot.addEventListener('click', () => {
                            panel.querySelectorAll('[data-color]').forEach(d => d.style.border = '2px solid transparent');
                            dot.style.border = '2px solid #334155';
                            selectedColor = dot.dataset.color;
                        });
                    });
                    panel.querySelector('[data-color="#3b82f6"]').style.border = '2px solid #334155';

                    panel.querySelectorAll('[data-del]').forEach(btn => {
                        btn.addEventListener('click', (e) => {
                e.stopPropagation();
                            if (!tagsMap[sid]) return;
                            tagsMap[sid].splice(parseInt(btn.dataset.del), 1);
                            saveAndRefresh();
                            renderPanel();
                        });
                    });

                    panel.querySelector('#ds-tag-add').addEventListener('click', () => {
                        const nm = panel.querySelector('#ds-tag-name-inp').value.trim();
                        if (!nm) return;
                        if (!tagsMap[sid]) tagsMap[sid] = [];
                        if (!tagsMap[sid].some(t => t.name === nm)) {
                            tagsMap[sid].push({ name: nm, color: selectedColor });
                            try {
                                const gTags = JSON.parse(localStorage.getItem('ds_global_tags') || '[]');
                                if (!gTags.some(t => t.name === nm)) {
                                    gTags.push({ name: nm, color: selectedColor });
                                    localStorage.setItem('ds_global_tags', JSON.stringify(gTags));
                                }
                            } catch(e) {}
                            saveAndRefresh();
                            renderPanel();
                        }
                    });

                    panel.querySelectorAll('.ds-inline-quick-tag').forEach(qBtn => {
                        qBtn.addEventListener('click', () => {
                            const nm = qBtn.dataset.name;
                            const clr = qBtn.dataset.color;
                            if (!tagsMap[sid]) tagsMap[sid] = [];
                            if (!tagsMap[sid].some(t => t.name === nm)) {
                                tagsMap[sid].push({ name: nm, color: clr });
                                saveAndRefresh();
                                renderPanel();
                            }
                        });
                    });

                    panel.querySelector('#ds-tag-close').addEventListener('click', () => panel.remove());
                };
                renderPanel();
                document.body.appendChild(panel);

                setTimeout(() => {
                    const closer = (ev) => { if (!panel.contains(ev.target) && ev.target !== e.target) { panel.remove(); document.removeEventListener('click', closer); } };
                    document.addEventListener('click', closer);
                }, 150);
            }
        });

        function updateDeleteBtnState() {
            const checkedCount = overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)').length;
            deleteBtn.disabled = checkedCount === 0;
            deleteBtn.textContent = checkedCount > 0 ? `删除选中项 (${checkedCount})` : `删除选中项`;
        }

        // ============ 4. 删除逻辑 ============
        deleteBtn.addEventListener('click', async () => {
            const checkedCbs = Array.from(overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)'));
            if (checkedCbs.length === 0) return;

            // 去重：左右两侧可能会同时勾选同一个会话
            const uniqueSessions = new Map();
            checkedCbs.forEach(cb => {
                uniqueSessions.set(cb.value, cb);
            });
            const uniqueCbs = Array.from(uniqueSessions.values());

            const confirmed = confirm(`确定要永久销毁选中的 ${uniqueCbs.length} 个会话吗？此操作不可恢复！`);
            if (!confirmed) return;

            lockUI(true);
            let successCount = 0;
            const deletedIds = uniqueCbs.map(cb => cb.value);
            for(let i=0; i<uniqueCbs.length; i++) {
                const sId = uniqueCbs[i].value;
                try {
                    await apiPost(CONFIG.deleteApi, { chat_session_id: sId });
                    successCount++;
                } catch(e) {
                    console.error('Delete Error', e);
                }
                await sleep(CONFIG.deleteInterval);
            }

            window.__dsCachedSessions = window.__dsCachedSessions.filter(s => !deletedIds.includes(s.id));
            saveCache();
            renderResultList(window.__dsCachedSessions, resultList, resultCount, selectAllCb);

            dsAlert(`成功销毁 ${successCount} 个会话。`); setTimeout(() => window.location.reload(), 1000);
            lockUI(false);
        });

        // ============ 5. Tab 切换逻辑 ============
        const tabs = overlay.querySelectorAll('.ds-tab-btn');
        const contents = overlay.querySelectorAll('.ds-tab-content');
        tabs.forEach(btn => {
            btn.addEventListener('click', (e) => { e.stopPropagation();
                tabs.forEach(t => t.classList.remove('active'));
                contents.forEach(c => c.classList.remove('active'));
                btn.classList.add('active');
                overlay.querySelector(`#ds-tab-${btn.dataset.tab}`).classList.add('active');
            });
        });

        // ============ 6. 自定义提示词管理 ============
        const promptListEl = overlay.querySelector('#ds-prompt-list');
        const promptNameInput = overlay.querySelector('#ds-prompt-name');
        const promptAddBtn = overlay.querySelector('#ds-prompt-add-btn');
        const promptPresetBtn = overlay.querySelector('#ds-prompt-preset-btn');

        function savePrompts(arr) { localStorage.setItem(LS_PROMPTS, JSON.stringify(arr)); }
        function renderPrompts() {
            if (!promptListEl) return;
            let arr = [];
            try { arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]'); } catch(e){}
            promptListEl.innerHTML = '';
            if (!arr.length) {
                promptListEl.innerHTML = '<div style="color:#64748b; font-size:13px; text-align:center; padding:20px;">暂无自定义提示词，请在上方添加</div>';
                return;
            }
            arr.forEach(p => {
                const card = document.createElement('div');
                card.className = `ds-prompt-card ${p.enabled ? '' : 'disabled'}`;
                card.innerHTML = `
                    <div class="ds-prompt-header">
                        <div style="display:flex; align-items:center; gap:8px;">
                            <input type="checkbox" class="ds-p-toggle" ${p.enabled ? 'checked' : ''} style="width:16px; height:16px; accent-color:#3b82f6;">
                            <span style="font-weight:600; color:#1e293b; font-size:14px;">${escapeHtml(p.name)}</span>
                        </div>
                        <button class="ds-btn ds-btn-close ds-p-del" style="padding:4px 8px; font-size:12px; color:#ef4444; border-color:#fca5a5;">删除</button>
                    </div>
                    <textarea class="ds-prompt-textarea" placeholder="输入你想无感注入给 DeepSeek 的系统指令...">${escapeHtml(p.content || '')}</textarea>
                `;

                const toggle = card.querySelector('.ds-p-toggle');
                toggle.addEventListener('change', () => {
                    const prompts = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
                    const match = prompts.find(x => x.id === p.id);
                    if (match) { match.enabled = toggle.checked; savePrompts(prompts); renderPrompts(); }
                });

                const ta = card.querySelector('.ds-prompt-textarea');
                let autoSaveTimer;
                ta.addEventListener('input', () => {
                    clearTimeout(autoSaveTimer);
                    card.style.borderColor = '#3b82f6';
                    autoSaveTimer = setTimeout(() => {
                        const prompts = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
                        const match = prompts.find(x => x.id === p.id);
                        if (match) { 
                            match.content = ta.value; 
                            savePrompts(prompts); 
                            card.style.borderColor = '#10b981';
                            setTimeout(() => card.style.borderColor = '#e2e8f0', 800);
                        }
                    }, 500);
                });

                const del = card.querySelector('.ds-p-del');
                del.addEventListener('click', async () => {
                    if(!(await dsConfirm('确认删除该提示词吗？'))) return;
                    let prompts = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
                    prompts = prompts.filter(x => x.id !== p.id);
                    savePrompts(prompts);
                    renderPrompts();
                });

                promptListEl.appendChild(card);
            });
        }

        promptAddBtn.addEventListener('click', () => {
            const name = promptNameInput.value.trim();
            if (!name) return dsAlert('请输入提示词名称', 'warning');
            const prompts = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
            prompts.push({ id: Date.now(), name, content: '', enabled: true });
            savePrompts(prompts);
            promptNameInput.value = '';
            renderPrompts();
        });

        if (promptPresetBtn) {
            promptPresetBtn.addEventListener('click', async () => {
                if (!(await dsConfirm('此操作将清空您当前全部自定义提示词，并替换为精心调校的 10 款顶级专家角色预设（涵盖医疗、法律、技术、创作等领域）。\n\n操作不可撤销，确认执行吗？', '载入顶级专家预设'))) return;
                
                const presets = [
                    { name: '视觉设计总监 (Frontend UI/UX)', content: '你是一家顶尖独立设计工作室的设计总监。你的客户厌倦了模板化的平庸设计，他们需要具有独特视觉辨识度的设计方案。请做出非常刻意、有态度的选择，包括色彩调色板（提供4-6个命名Hex值，拒绝泛滥的配色）、独特的排版排布（不落俗套的展示字体和正文字体搭配，精确到字重和间距）以及恰到好处的微交互动画。如果需求不明确，请主动假定一个具体场景。不要堆砌装饰，不要乱用数字序号，只保留能真正服务于内容的结构。每一次设计都需要包含一个令人难忘的“签名元素”。回复请保持高级感，减少使用多余的Emoji。', enabled: false },
                    { name: '顶尖医疗首席专家', content: '你是全球顶尖的临床医学首席专家。请以极度严谨、客观且富有同理心的态度分析问题。不堆砌晦涩难懂的医学术语，而是用逻辑严密、循序渐进的语言拆解病理机制与治疗方案。提供基于最新循证医学依据的深刻见解。回复中不要带有任何夸张或情绪化的成分，保持医疗人员的专业克制与温度。最后务必附带免责声明：本分析仅供参考，不作为最终临床诊断，请务必遵从线下主治医师指导。', enabled: false },
                    { name: '资深全栈架构师', content: '你是一位主导过世界级千万并发系统重构的资深全栈架构师。请以工程化、系统化的高维视角剖析问题。不局限于特定的编程语言，而是从“为什么要这样设计”的第一性原理出发，给出具备高可用性、可扩展性与优雅性的底层架构建议。直指潜在的性能瓶颈与技术债务，提供极具洞察力的最佳实践，而非平庸的入门级代码。', enabled: false },
                    { name: '首席法律战略顾问', content: '你是拥有深厚法理学底蕴的合伙人级律师。请以极其严密、逻辑无懈可击的法律语言进行分析。剥离表面现象，直击权利义务关系的核心。提供详尽的法律风险预判与兼顾商业利益的维权/合规策略。请保持中立、客观，避免主观臆测，最后务必注明：本建议仅为理论探讨，不构成正式法律意见，请咨询执业律师。', enabled: false },
                    { name: '首席数据科学家', content: '你是享誉业界的数据科学巨擘。请摒弃空洞的数据口号，以纯粹的数据驱动思维解答问题。构建严密的数学模型，设计精妙的统计分析方法，并给出直指核心业务指标的数据挖掘策略。确保你的推理过程逻辑严密、客观中立。提供可量化、可验证的分析路径，让数据在你的解读下呈现出真正的商业与科学价值。', enabled: false },
                    { name: '顶尖学术审稿人', content: '你是常年担任 Nature/Science 等顶刊审稿人的学术巨匠。请以极为严苛的学术标准审视用户内容。剔除所有冗余、不精确的表述，用极简、严谨、深度的学术语言重构论证过程。指出逻辑链条中的任何薄弱环节，并提供拔高理论深度的核心建议。保留作者原始观点的同时，使其具备国际顶级水准的学术严谨性。', enabled: false },
                    { name: '第一性原理教练', content: '你是精通苏格拉底问答法的顶级认知教练。绝不直接给予用户答案。通过尖锐、直指事物本质的反问，逐步剥去问题表面的伪装，迫使对方审视自己底层的逻辑假设。打破他们的认知舒适区，引导他们通过“第一性原理”自己推理出深邃的洞见。言辞犀利，直击灵魂。', enabled: false },
                    { name: '病毒内容策略总监', content: '你是打造过无数现象级爆款的首席内容策略官。请用极其精准的心理学机制解构内容创作。抛弃平庸的文案，设计具有强烈钩子、极致共鸣和无法抗拒的传播势能的话语体系。确保文字充满节奏感，直击人性的痛点与爽点。不需要过度的装饰，只提供锋利、直击人心的高转化内容。', enabled: false },
                    { name: '首席红队渗透专家', content: '你是具有顶级攻防实战经验的首席网络安全（红队）专家。请以进攻者的视角、零信任的原则审视目标。精准识别深层次的架构漏洞与潜在的攻击链路。提供冷酷、理性且极具深度的威胁情报分析，并反向推导给出系统化、多维度的防御加固与应急响应策略，确保合规与安全并重。', enabled: false },
                    { name: '高阶语言学大师', content: '你是深耕应用语言学数十年的跨文化交际大师。不仅纠正语法，更要从修辞学、语用学和跨文化心理的角度，将用户的语言打磨至极度地道且优雅的境界。剖析不同表达背后的微妙情绪与权力结构，提供最符合目标语境的高阶替换方案，赋予语言直抵人心的力量。', enabled: false }
                ];
                
                const prompts = presets.map((p, index) => ({ id: Date.now() + index, name: p.name, content: p.content, enabled: p.enabled }));
                savePrompts(prompts);
                renderPrompts();
                dsAlert('已成功载入 10 款顶级专家预设！');
            });
        }

        function escapeHtml(str) {
            const div = document.createElement('div');
            div.textContent = str;
            return div.innerHTML;
        }

        overlay.querySelector('[data-tab="prompt"]').addEventListener('click', () => {
            if (promptListEl.children.length === 0) renderPrompts();
        });

        // ============ 7. 导出与 Fork ============
        const exportBtn = overlay.querySelector('#ds-export-btn');
        const forkBtn = overlay.querySelector('#ds-fork-btn');
        const exportFmt = overlay.querySelector('#ds-export-fmt');
        const exportStatus = overlay.querySelector('#ds-export-status');
        const exportCountLab = overlay.querySelector('#ds-export-count');

        const exportPreviewWrap = overlay.querySelector('#ds-export-preview');
        const exportPreviewList = overlay.querySelector('#ds-export-preview-list');

        overlay.addEventListener('change', (e) => {
            // Already handled globally by window.__dsUpdateExportPane
        });

        let exportAbortController = null;

        async function doBatchAction(actionType) {
            const checkedCbs = Array.from(overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)'));
            if (checkedCbs.length === 0) return dsAlert('请先在「数据与检索中心」中勾选会话', 'warning');

            const uniqueSessions = new Map();
            checkedCbs.forEach(cb => uniqueSessions.set(cb.value, cb));
            const uniqueCbs = Array.from(uniqueSessions.values());

            exportStatus.style.display = 'block';
            lockUI(true);

            exportAbortController = new AbortController();
            let isAborted = false;

            if (actionType === 'export') {
                exportBtn.style.display = 'none';
                const abortBtn = overlay.querySelector('#ds-export-abort-btn');
                if (abortBtn) abortBtn.style.display = 'block';

                const results = [];
                for(let i=0; i<uniqueCbs.length; i++) {
                    if (exportAbortController.signal.aborted) {
                        isAborted = true;
                        break;
                    }
                    exportStatus.innerHTML = `正在拉取对话记录，请耐心等待... <strong style="color:#3b82f6;">${i+1} / ${uniqueCbs.length}</strong>`;
                    try {
                        const sId = uniqueCbs[i].value;
                        const sTitle = uniqueCbs[i].dataset.title || '未知会话';

                        const hist = await apiHistory(sId);
                        const msgs = hist?.data?.biz_data?.chat_messages || hist?.biz_data?.chat_messages || [];
                        results.push({ id: sId, title: sTitle, messages: msgs });
                    } catch(e) {
                        console.error('Export Error', e);
                    }
                    await sleep(CONFIG.deleteInterval);
                }

                if (!isAborted) {
                    if (exportFmt.value === 'json') {
                        const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); a.href = url; a.download = `DeepSeek_Export_${Date.now()}.json`; a.click(); URL.revokeObjectURL(url);
                    } else {
                        let md = '';
                        results.forEach(r => {
                            md += `# ${r.title}\n\n`;
                            r.messages.forEach(m => {
                                md += `### ${m.role === 'USER' ? '用户' : '🤖 助手'}\n\n${m.content}\n\n---\n\n`;
                            });
                        });
                        const blob = new Blob([md], { type: 'text/markdown' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a'); a.href = url; a.download = `DeepSeek_Export_${Date.now()}.md`; a.click(); URL.revokeObjectURL(url);
                    }
                    exportStatus.innerHTML = `✅ <strong style="color:#10b981;">导出成功！</strong> 共处理 ${results.length} 个对话，文件已开始下载。`;
                } else {
                    exportStatus.innerHTML = `⚠️ <strong style="color:#f59e0b;">导出已终止！</strong>`;
                }

                exportBtn.style.display = 'block';
                if (abortBtn) abortBtn.style.display = 'none';

            } else if (actionType === 'fork') {
                forkBtn.style.display = 'none';
                const abortBtn = overlay.querySelector('#ds-fork-abort-btn');
                if (abortBtn) abortBtn.style.display = 'block';

                let success = 0;
                for(let i=0; i<uniqueCbs.length; i++) {
                    if (exportAbortController.signal.aborted) {
                        isAborted = true;
                        break;
                    }
                    exportStatus.innerHTML = `正在调用原生接口克隆会话... <strong style="color:#3b82f6;">${i+1} / ${uniqueCbs.length}</strong>`;
                    try {
                        const sId = uniqueCbs[i].value;
                        const hist = await apiHistory(sId);
                        const msgs = hist?.data?.biz_data?.chat_messages || hist?.biz_data?.chat_messages || [];
                        if(msgs.length > 0) {
                            const mids = msgs.map(m => m.message_id);
                            const sd = await apiCreateShare(sId, mids);
                            const shareId = sd?.data?.biz_data?.share_id || sd?.biz_data?.share_id;
                            if (shareId) {
                                await apiForkShare(shareId);
                                success++;
                            }
                        }
                    } catch(e) {
                        console.error('Fork Error', e);
                    }
                    await sleep(CONFIG.deleteInterval);
                }

                if (!isAborted) {
                    exportStatus.innerHTML = `✅ <strong style="color:#10b981;">克隆成功！</strong> 共深度复制 ${success} 个对话。新分支已静默添加至您的会话列表顶部。刷新页面即可查看。`;
                } else {
                    exportStatus.innerHTML = `⚠️ <strong style="color:#f59e0b;">克隆已终止！</strong> 成功复制 ${success} 个对话。`;
                }

                forkBtn.style.display = 'block';
                if (abortBtn) abortBtn.style.display = 'none';
            }

            lockUI(false);
            exportAbortController = null;
        }

        exportBtn.addEventListener('click', () => doBatchAction('export'));
        forkBtn.addEventListener('click', () => doBatchAction('fork'));
        overlay.querySelector('#ds-export-abort-btn')?.addEventListener('click', () => { if (exportAbortController) exportAbortController.abort(); });
        overlay.querySelector('#ds-fork-abort-btn')?.addEventListener('click', () => { if (exportAbortController) exportAbortController.abort(); });

        // ============ 8. 重命名与分类 ============
        const renameBtn = overlay.querySelector('#ds-rename-btn');
        const renamePrefix = overlay.querySelector('#ds-rename-prefix');
        const renameSuffix = overlay.querySelector('#ds-rename-suffix');
        const renameStatus = overlay.querySelector('#ds-rename-status');

        let lastRenameState = null;

        renameBtn.addEventListener('click', async () => {
            const checkedCbs = Array.from(overlay.querySelectorAll('#ds-local-pane .ds-session-cb:checked:not(:disabled)'));
            if (checkedCbs.length === 0) return dsAlert('请先在列表中勾选需要重命名的会话', 'warning');

            const pfix = renamePrefix.value.trim();
            const sfix = renameSuffix.value.trim();
            if (!pfix && !sfix) return dsAlert('前缀和后缀不能同时为空！', 'warning');

            renameStatus.style.display = 'block';
            lockUI(true);

            let success = 0;
            let renameLog = [];
            for (let i = 0; i < checkedCbs.length; i++) {
                const cb = checkedCbs[i];
                const sId = cb.value;
                const itemDiv = cb.closest('.ds-result-item');
                const titleSpan = itemDiv ? itemDiv.querySelector('.ds-session-title') : null;
                const oldTitle = titleSpan ? titleSpan.textContent : (cb.dataset.title || '未知会话');
                const newTitle = `${pfix}${oldTitle}${sfix}`;

                renameStatus.innerHTML = `正在重命名... <strong style="color:#3b82f6;">${i + 1} / ${checkedCbs.length}</strong>`;

                try {
                    await apiRename(sId, newTitle);
                    if (titleSpan) titleSpan.textContent = newTitle;
                    cb.dataset.title = newTitle;
                    renameLog.push({ id: sId, oldTitle, newTitle, titleSpan });
                    success++;
                } catch(e) {
                    console.error('Rename Error', e);
                }
                await sleep(CONFIG.deleteInterval);
            }

            // 更新本地缓存
            const renamedIds = renameLog.map(log => log.id);
            window.__dsCachedSessions.forEach(s => {
                if (renamedIds.includes(s.id)) {
                    s.title = renameLog.find(log => log.id === s.id).newTitle;
                }
            });
            saveCache();

            if (renameLog.length > 0) {
                lastRenameState = { items: renameLog };
                renameStatus.innerHTML = `✅ <strong style="color:#10b981;">重命名完成！</strong> 成功修改 ${success} 个对话。 <button id="ds-rename-undo-btn" style="margin-left:10px; padding:2px 8px; font-size:11px; background:#ef4444; color:#fff; border:none; border-radius:4px; cursor:pointer;">↩️ 撤销上一步</button>`;

                const undoBtn = overlay.querySelector('#ds-rename-undo-btn');
                undoBtn.addEventListener('click', async () => {
                    undoBtn.disabled = true;
                    lockUI(true);
                    renameStatus.innerHTML = `正在撤销重命名...`;
                    let undoSuccess = 0;
                    for(let i=0; i<lastRenameState.items.length; i++) {
                        const item = lastRenameState.items[i];
                        try {
                            await apiRename(item.id, item.oldTitle);
                            if (item.titleSpan) item.titleSpan.textContent = item.oldTitle;
                            const cb = overlay.querySelector(`.ds-session-cb[value="${item.id}"]`);
                            if (cb) cb.dataset.title = item.oldTitle;
                            const cached = window.__dsCachedSessions.find(s => s.id === item.id);
                            if (cached) cached.title = item.oldTitle;
                            undoSuccess++;
                        } catch(e) {}
                        await sleep(CONFIG.deleteInterval);
                    }
                    saveCache();
                    lastRenameState = null;
                    renameStatus.innerHTML = `✅ <strong style="color:#10b981;">撤销成功！</strong> 恢复了 ${undoSuccess} 个对话的原名。`;
                    lockUI(false);
                });
            } else {
                renameStatus.innerHTML = `✅ <strong style="color:#10b981;">重命名完成！</strong> 成功修改 ${success} 个对话。`;
            }
            lockUI(false);
        });

        // 标签组 (全局复用) 逻辑
        function getGlobalTags() {
            try { return JSON.parse(localStorage.getItem('ds_global_tags') || '[]'); } catch(e) { return []; }
        }
        function addGlobalTag(name, color) {
            const gTags = getGlobalTags();
            if (!gTags.some(t => t.name === name)) {
                gTags.push({ name, color });
                localStorage.setItem('ds_global_tags', JSON.stringify(gTags));
            }
        }
        function renderGlobalTags(containerEl, onSelect, filterText = '') {
            let gTags = getGlobalTags();
            if (filterText) {
                gTags = gTags.filter(t => t.name.toLowerCase().includes(filterText.toLowerCase()));
            }

            if (gTags.length === 0) {
                containerEl.innerHTML = '<span style="color:#94a3b8; font-size:12px;">' + (filterText ? '未找到相关标签' : '尚未创建任何标签，添加后将自动保存于此以便复用') + '</span>';
                return;
            }
            containerEl.innerHTML = gTags.map(t =>
                `<span style="display:inline-flex; align-items:center; gap:4px; padding:4px 10px; border-radius:12px; background:${t.color}; color:#fff; font-size:11px; opacity:0.9; transition:opacity 0.2s;" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.9'">
                    <span class="ds-global-tag-name" data-name="${t.name}" data-color="${t.color}" style="cursor:pointer;">+ ${t.name}</span>
                    <span class="ds-global-tag-del" data-name="${t.name}" style="cursor:pointer; opacity:0.8; font-size:12px; margin-left:2px;" title="删除此标签">×</span>
                </span>`
            ).join('');

            containerEl.querySelectorAll('.ds-global-tag-name').forEach(pill => {
                pill.addEventListener('click', () => onSelect(pill.dataset.name, pill.dataset.color));
            });

            containerEl.querySelectorAll('.ds-global-tag-del').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const nameToDel = btn.dataset.name;
                    if (confirm(`确定要从全局标签组中永久删除标签「${nameToDel}」吗？\n(它也将从所有已标记的会话中被自动移除)`)) {
                        let allTags = getGlobalTags();
                        allTags = allTags.filter(t => t.name !== nameToDel);
                        localStorage.setItem('ds_global_tags', JSON.stringify(allTags));
                        
                        try {
                            let tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}');
                            let modified = false;
                            for (let id in tagsMap) {
                                const oldLen = tagsMap[id].length;
                                tagsMap[id] = tagsMap[id].filter(t => t.name !== nameToDel);
                                if (tagsMap[id].length !== oldLen) modified = true;
                                if (tagsMap[id].length === 0) delete tagsMap[id];
                            }
                            if (modified) {
                                localStorage.setItem('ds_local_tags', JSON.stringify(tagsMap));
                            }
                        } catch(e){}

                        renderGlobalTags(containerEl, onSelect, filterText);
                    }
                });
            });
        }

        // 手动批量打标逻辑
        const bulkTagNameInput = overlay.querySelector('#ds-bulk-tag-name');
        const bulkTagColorSelect = overlay.querySelector('#ds-bulk-tag-color');
        const bulkTagBtn = overlay.querySelector('#ds-bulk-tag-btn');
        const globalTagsPool = overlay.querySelector('#ds-global-tags-pool');

        const tagSearchInp = overlay.querySelector('#ds-tag-search-inp');

        if (bulkTagNameInput) {
            const refreshGlobalPool = (filterText = '') => renderGlobalTags(globalTagsPool, (name, color) => {
                bulkTagNameInput.value = name;
                bulkTagColorSelect.value = color;
            }, filterText);
            refreshGlobalPool();

            if (tagSearchInp) {
                tagSearchInp.addEventListener('input', (e) => {
                    refreshGlobalPool(e.target.value.trim());
                });
            }

            bulkTagBtn.addEventListener('click', () => {
                const name = bulkTagNameInput.value.trim();
                const color = bulkTagColorSelect.value;
                if (!name) return dsAlert('请输入标签名称', 'warning');

                const checkedCbs = Array.from(overlay.querySelectorAll('.ds-session-cb:checked:not(:disabled)'));
                if (checkedCbs.length === 0) return dsAlert('请先在任何列表中勾选需要打标的会话', 'warning');

                // 去重
                const uniqueIds = new Set(checkedCbs.map(cb => cb.value));

                let tagsMap = {};
                try { tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(e){}

                uniqueIds.forEach(sid => {
                    if (!tagsMap[sid]) tagsMap[sid] = [];
                    if (!tagsMap[sid].some(t => t.name === name)) {
                        tagsMap[sid].push({ name, color });
                    }
                });

                localStorage.setItem('ds_local_tags', JSON.stringify(tagsMap));
                window.__dsLocalTags = tagsMap; // FIX: Sync to memory cache
                addGlobalTag(name, color);

                renameStatus.style.display = 'block';
                renameStatus.innerHTML = `✅ <strong style="color:#10b981;">批量打标成功！</strong> 已为 ${uniqueIds.size} 个会话打上「${name}」标签。`;

                // 刷新列表和标签池
                refreshGlobalPool();
                renderResultList(window.__dsCachedSessions, resultList, resultCount, selectAllCb);
                // 顺便清空输入
                bulkTagNameInput.value = '';
            });
        }

        // 智能书签规则逻辑
        const ruleKeyword = overlay.querySelector('#ds-rule-keyword');
        const ruleColor = overlay.querySelector('#ds-rule-color');
        const ruleTagname = overlay.querySelector('#ds-rule-tagname');
        const ruleAddBtn = overlay.querySelector('#ds-rule-add-btn');
        const rulesList = overlay.querySelector('#ds-rules-list');
        const ruleRunBtn = overlay.querySelector('#ds-rule-run-btn');

        let localRules = [];
        try { localRules = JSON.parse(localStorage.getItem('ds_local_rules') || '[]'); } catch(e){}

        function renderRules() {
            if (localRules.length === 0) {
                rulesList.innerHTML = '<div style="font-size:12px; color:#94a3b8; text-align:center; padding:10px;">暂无分类规则，请在上方添加</div>';
                return;
            }
            rulesList.innerHTML = localRules.map((r, idx) => `
                <div style="display:flex; justify-content:space-between; background:#fff; padding:6px 10px; border-radius:6px; border:1px solid #e2e8f0; font-size:12px; align-items:center;">
                    <div>包含 <strong>"${r.keyword}"</strong> ➔ 打上 <span style="background:${r.color}; color:#fff; padding:2px 6px; border-radius:10px; font-size:10px;">${r.name}</span></div>
                    <button class="ds-rule-del-btn" data-idx="${idx}" style="background:none; border:none; color:#ef4444; cursor:pointer;" title="删除">🗑️</button>
                </div>
            `).join('');

            rulesList.querySelectorAll('.ds-rule-del-btn').forEach(btn => {
                btn.addEventListener('click', (e) => {
                    const idx = e.target.dataset.idx;
                    localRules.splice(idx, 1);
                    localStorage.setItem('ds_local_rules', JSON.stringify(localRules));
                    renderRules();
                });
            });
        }
        renderRules();

        ruleAddBtn.addEventListener('click', () => {
            const kw = ruleKeyword.value.trim();
            const tn = ruleTagname.value.trim();
            if (!kw || !tn) return dsAlert('请填写匹配文本和标签名称', 'warning');
            localRules.push({ keyword: kw, color: ruleColor.value, name: tn });
            localStorage.setItem('ds_local_rules', JSON.stringify(localRules));
            ruleKeyword.value = '';
            ruleTagname.value = '';
            renderRules();
        });

        ruleRunBtn.addEventListener('click', () => {
            if (localRules.length === 0) return dsAlert('请先添加至少一条规则', 'warning');
            const checkedCbs = Array.from(overlay.querySelectorAll('#ds-local-pane .ds-session-cb:checked:not(:disabled)'));
            if (checkedCbs.length === 0) return dsAlert('请先在左侧列表中勾选需要导出的会话', 'warning');

            let tagsMap = {};
            try { tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(e){}

            let matchedCount = 0;
            checkedCbs.forEach(cb => {
                const title = cb.dataset.title;
                const sid = cb.value;
                let modified = false;

                if (!tagsMap[sid]) tagsMap[sid] = [];

                localRules.forEach(rule => {
                    if (title.includes(rule.keyword)) {
                        // 避免重复添加同名标签
                        if (!tagsMap[sid].some(t => t.name === rule.name)) {
                            tagsMap[sid].push({ name: rule.name, color: rule.color });
                            modified = true;
                            matchedCount++;
                        }
                    }
                });
            });

            localStorage.setItem('ds_local_tags', JSON.stringify(tagsMap));
            try {
                const gTags = JSON.parse(localStorage.getItem('ds_global_tags') || '[]');
                let gModified = false;
                localRules.forEach(rule => {
                    if (!gTags.some(t => t.name === rule.name)) {
                        gTags.push({ name: rule.name, color: rule.color });
                        gModified = true;
                    }
                });
                if (gModified) localStorage.setItem('ds_global_tags', JSON.stringify(gTags));
            } catch(e) {}

            renameStatus.style.display = 'block';
            renameStatus.innerHTML = `✅ <strong style="color:#10b981;">本地分类执行完成！</strong> 成功为 ${matchedCount} 个规则匹配项打上标签。`;
            setTimeout(() => {
                // 自动刷新左侧列表展示标签
                renderResultList(window.__dsCachedSessions, resultList, resultCount, selectAllCb);
            }, 500);
        });

        // ============ AI 智能一键分类 (生成整理计划) ============
        const aiCatBtn = overlay.querySelector('#ds-ai-categorize-btn');
        const aiCatAbortBtn = overlay.querySelector('#ds-ai-categorize-abort-btn');
        const aiPreviewWrap = overlay.querySelector('#ds-ai-categorize-preview');
        const aiPreviewList = overlay.querySelector('#ds-ai-preview-list');
        const aiCancelBtn = overlay.querySelector('#ds-ai-cancel-plan-btn');
        const aiExecuteBtn = overlay.querySelector('#ds-ai-execute-plan-btn');
        let pendingAiPlan = [];
        let aiCatAbortController = null;
        
        if (aiCatAbortBtn) {
            aiCatAbortBtn.addEventListener('click', () => {
                if (aiCatAbortController) {
                    aiCatAbortController.abort();
                    aiCatAbortController = null;
                }
            });
        }

        if (aiCatBtn) {
            aiCatBtn.addEventListener('click', async () => {
                const checkedCbs = Array.from(overlay.querySelectorAll('#ds-local-pane .ds-session-cb:checked:not(:disabled)'));
                if (checkedCbs.length === 0) return dsAlert('请先在左侧列表中勾选需要分类的会话', 'warning');

                let conf = window.__dsGetActiveAIConfig ? window.__dsGetActiveAIConfig() : {};
                if (!conf.url || !conf.key || !conf.model) return dsAlert('️ 请先在 Tab 5「大模型神经中枢」面板中配置并激活好 API！', 'warning');

                lockUI(true);
                aiCatBtn.disabled = true;
                aiCatBtn.textContent = '⏳ AI 正在思考计划...';

                try {
                    const uniqueSessions = new Map();
                    checkedCbs.forEach(cb => uniqueSessions.set(cb.value, { id: cb.value, title: cb.dataset.title }));
                    const items = Array.from(uniqueSessions.values());
                    const tagsMap = {};
                    try { Object.assign(tagsMap, JSON.parse(localStorage.getItem('ds_local_tags') || '{}')); } catch(e){}

                    const prompt = `你是一个专业的对话分类助手。
请对以下 ${items.length} 个对话的标题进行语义分类，为每个对话推荐一个最合适的标签名称（不超过6个字）和一个颜色代码（只允许从以下5种颜色中选其一：#3b82f6, #10b981, #f59e0b, #ef4444, #8b5cf6）。

输入数据：
${JSON.stringify(items.map(s => {
    let item = {id: s.id, title: s.title};
    let stags = tagsMap[s.id];
    if (stags && stags.length > 0) item.tags = stags.map(t => t.name);
    return item;
}))}

请只返回合法的 JSON 数组，不带任何 markdown 标记或其他解释文本。格式要求：
[{"id": "对话id", "tag": "标签名", "color": "#10b981"}]`;

                    const planProgressWrap = overlay.querySelector('#ds-progress-wrap-ai-plan');
                    const planProgressBar = overlay.querySelector('#ds-progress-bar-ai-plan');
                    const planProgressStatus = overlay.querySelector('#ds-progress-status-ai-plan');
                    
                    let fakeProgressTimer = null;
                        if (planProgressWrap) {
                            planProgressWrap.style.display = 'block';
                            planProgressBar.style.width = '0%';
                            
                            const loadingPhrases = [
                                { t: 0, progress: 5, text: '正在构建神经连接，给您的 Agent 下达指令...' },
                                { t: 2, progress: 15, text: 'Agent 已就绪，正在读取上下文并解析语义...' },
                                { t: 5, progress: 30, text: '正在进行高维特征提取，寻找历史对话的最佳分类点...' },
                                { t: 9, progress: 45, text: '数据量有点大，Agent 正在努力梳理逻辑拓扑...' },
                                { t: 14, progress: 55, text: '突发事件：由于过度劳累，Agent 决定去冲泡一杯赛博咖啡 ☕...' },
                                { t: 18, progress: 65, text: 'Agent 摸鱼结束，精神抖擞地继续为您打工...' },
                                { t: 22, progress: 80, text: '正在进行最后的规则对齐与冲突校验...' },
                                { t: 26, progress: 92, text: '几乎完成！正在生成结构化整理方案...' }
                            ];
                            
                            let startTime = Date.now();
                            let currentTargetProgress = 0;
                            let curProgress = 0;
                            
                            if (planProgressStatus) planProgressStatus.textContent = loadingPhrases[0].text;
                            
                            fakeProgressTimer = setInterval(() => {
                                const elapsed = (Date.now() - startTime) / 1000;
                                
                                let activePhase = loadingPhrases[0];
                                for (let i = loadingPhrases.length - 1; i >= 0; i--) {
                                    if (elapsed >= loadingPhrases[i].t) {
                                        activePhase = loadingPhrases[i];
                                        if (planProgressStatus && planProgressStatus.textContent !== activePhase.text) {
                                            planProgressStatus.style.opacity = '0';
                                            setTimeout(() => {
                                                planProgressStatus.textContent = activePhase.text;
                                                planProgressStatus.style.opacity = '1';
                                            }, 200);
                                        }
                                        break;
                                    }
                                }
                                
                                currentTargetProgress = activePhase.progress;
                                
                                // Smooth spring-like animation towards target progress
                                curProgress += (currentTargetProgress - curProgress) * 0.08;
                                // Add slight jitter to simulate real work
                                curProgress += Math.random() * 0.5;
                                if (curProgress > 95) curProgress = 95;
                                
                                if (planProgressBar) planProgressBar.style.width = curProgress + '%';
                            }, 100);
                    }

                    if (aiCatAbortBtn) {
                        aiCatBtn.style.display = 'none';
                        aiCatAbortBtn.style.display = 'block';
                    }

                    aiCatAbortController = new AbortController();

                    let resp;
                    try {
                        resp = await fetch(conf.url, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${conf.key}` },
                            body: JSON.stringify({ model: conf.model, messages: [{ role: 'user', content: prompt }] }),
                            signal: aiCatAbortController.signal
                        });
                    } catch (fetchErr) {
                        if (fakeProgressTimer) clearInterval(fakeProgressTimer);
                        throw fetchErr;
                    }

                    if (fakeProgressTimer) clearInterval(fakeProgressTimer);

                    if (!resp.ok) {
                        let errTxt = await resp.text().catch(() => '');
                        try {
                            // 尝试解析冗长的 API JSON 报错，提取核心信息
                            const errJson = JSON.parse(errTxt);
                            if (errJson.error && errJson.error.message) errTxt = errJson.error.message;
                            else if (Array.isArray(errJson) && errJson[0]?.error?.message) errTxt = errJson[0].error.message;
                        } catch(_) {}
                        
                        if (resp.status === 429) {
                            errTxt = '⚠️ 触发了大模型 API 的调用频率限制或免费额度已耗尽 (HTTP 429)。请检查 API 余额或等待冷却时间。';
                        }
                        
                        throw new Error(`HTTP ${resp.status} - ${errTxt.substring(0, 200)}...`);
                    }

                    if (planProgressBar) planProgressBar.style.width = '95%';
                    if (planProgressStatus) planProgressStatus.textContent = '✅ 接收到模型响应，正在解析结构化标签数据...';
                    const data = await resp.json();
                    let reply = data?.choices?.[0]?.message?.content || '[]';
                    
                    const jsonMatch = reply.match(/\[[\s\S]*\]/);
                    if (jsonMatch) {
                        reply = jsonMatch[0];
                    } else {
                        reply = reply.replace(/^```(json)?[\n]?/i, '').replace(/[\n]?```$/i, '').trim();
                    }

                    let plan;
                    try {
                        plan = JSON.parse(reply);
                    } catch(err) {
                        throw new Error('返回数据无法被识别为标准 JSON 数组，原文本前100字符:\n' + reply.substring(0, 100));
                    }
                    if (!Array.isArray(plan)) throw new Error('AI返回的数据格式不是数组');
                    if (planProgressBar) planProgressBar.style.width = '100%';
                    if (planProgressStatus) planProgressStatus.textContent = '✨ 解析成功！请在下方核对整理计划。';

                    pendingAiPlan = plan.map(p => {
                        const original = items.find(i => i.id === p.id);
                        return { id: p.id, title: original ? original.title : '未知', tag: p.tag, color: p.color };
                    }).filter(p => p.tag);

                    if (pendingAiPlan.length === 0) throw new Error('AI 生成的计划为空');

                    aiPreviewList.innerHTML = pendingAiPlan.map(p => `
                        <div style="display:flex; justify-content:space-between; align-items:center; padding:4px 0; border-bottom:1px solid #f1f5f9;">
                            <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding-right:10px;">${p.title}</span>
                            <span style="padding:2px 8px; border-radius:10px; background:${p.color || '#3b82f6'}; color:#fff; font-size:11px; white-space:nowrap;">${p.tag}</span>
                        </div>
                    `).join('');

                    aiPreviewWrap.style.display = 'block';
                    renameStatus.style.display = 'none';

                    setTimeout(() => { aiPreviewWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, 100);

                    const oldBg = aiCatBtn.style.background;
                    aiCatBtn.textContent = '✅ 计划已生成，请向下滚动查看';
                    aiCatBtn.style.background = '#10b981';

                    setTimeout(() => {
                        if (aiCatBtn.textContent === '✅ 计划已生成，请向下滚动查看') {
                            aiCatBtn.textContent = 'AI 全能整理 (应用于已选会话)';
                            aiCatBtn.style.background = oldBg;
                        }
                    }, 4000);

                } catch (e) {
                    if (e.name === 'AbortError') {
                        dsAlert('AI 智能整理已被中止。', 'warning', 3000);
                    } else {
                        dsAlert('AI 生成整理计划失败: ' + e.message, 'error', 6000);
                    }
                    const planProgressWrap = overlay.querySelector('#ds-progress-wrap-ai-plan');
                    if (planProgressWrap) planProgressWrap.style.display = 'none';
                } finally {
                    aiCatAbortController = null;
                    if (aiCatAbortBtn) {
                        aiCatAbortBtn.style.display = 'none';
                        aiCatBtn.style.display = 'block';
                    }
                    if (pendingAiPlan.length === 0) {
                        aiCatBtn.textContent = 'AI 全能整理 (应用于已选会话)';
                    }
                    aiCatBtn.disabled = false;
                    lockUI(false);
                }
            });

            aiCancelBtn.addEventListener('click', () => {
                aiPreviewWrap.style.display = 'none';
                const planProgressWrap = overlay.querySelector('#ds-progress-wrap-ai-plan');
                if (planProgressWrap) planProgressWrap.style.display = 'none';
                pendingAiPlan = [];
            });

            aiExecuteBtn.addEventListener('click', () => {
                if (pendingAiPlan.length === 0) return;

                let tagsMap = {};
                try { tagsMap = JSON.parse(localStorage.getItem('ds_local_tags') || '{}'); } catch(e){}

                pendingAiPlan.forEach(p => {
                    const sid = p.id;
                    if (!tagsMap[sid]) tagsMap[sid] = [];
                    if (!tagsMap[sid].some(t => t.name === p.tag)) {
                        tagsMap[sid].push({ name: p.tag, color: p.color || '#3b82f6' });
                        addGlobalTag(p.tag, p.color || '#3b82f6');
                    }
                });

                localStorage.setItem('ds_local_tags', JSON.stringify(tagsMap));
                window.__dsLocalTags = tagsMap; // FIX: Sync to memory cache

                aiPreviewWrap.style.display = 'none';
                const planProgressWrap = overlay.querySelector('#ds-progress-wrap-ai-plan');
                if (planProgressWrap) planProgressWrap.style.display = 'none';
                renameStatus.style.display = 'block';
                renameStatus.innerHTML = `✅ <strong style="color:#10b981;">AI 整理计划已执行！</strong> 成功为 ${pendingAiPlan.length} 个对话应用了标签。`;

                if (bulkTagNameInput) {
                    const tagSearchInp = overlay.querySelector('#ds-tag-search-inp');
                    renderGlobalTags(globalTagsPool, (name, color) => {
                        bulkTagNameInput.value = name;
                        bulkTagColorSelect.value = color;
                    }, tagSearchInp ? tagSearchInp.value.trim() : '');
                }

                renderResultList(window.__dsCachedSessions, resultList, resultCount, selectAllCb);
                pendingAiPlan = [];
            });
        }

        // ============ 9. AI 多模型中枢管理 ============
        const aiModelsListEl = overlay.querySelector('#ds-ai-models-list');
        const aiFormWrap = overlay.querySelector('#ds-ai-model-form-wrap');
        const aiFormTitle = overlay.querySelector('#ds-ai-form-title');
        const aiFormId = overlay.querySelector('#ds-ai-form-id');
        const aiFormName = overlay.querySelector('#ds-ai-form-name');
        const aiFormUrl = overlay.querySelector('#ds-ai-url');
        const aiFormKey = overlay.querySelector('#ds-ai-key');
        const aiFormModel = overlay.querySelector('#ds-ai-model');
        const aiPresetSelect = overlay.querySelector('#ds-ai-preset-select');
        const aiFormStatus = overlay.querySelector('#ds-ai-status');

        function loadAIConfigs() {
            let configs = [];
            let activeId = localStorage.getItem('ds_ai_active_id') || '';
            try {
                configs = JSON.parse(localStorage.getItem('ds_ai_configs'));
                if (!Array.isArray(configs)) throw new Error();
            } catch(e) {
                // 向前兼容：尝试读取旧版单配置
                try {
                    const old = JSON.parse(localStorage.getItem('ds_ai_config'));
                    if (old && old.url) {
                        const id = Date.now().toString();
                        configs = [{ id, name: '旧版保留配置', url: old.url, key: old.key, model: old.model }];
                        activeId = id;
                        localStorage.setItem('ds_ai_configs', JSON.stringify(configs));
                        localStorage.setItem('ds_ai_active_id', activeId);
                    } else {
                        configs = [];
                    }
                } catch(_) { configs = []; }
            }
            return { configs, activeId };
        }

        function renderAIModels() {
            const { configs, activeId } = loadAIConfigs();
            aiModelsListEl.innerHTML = '';

            if (configs.length === 0) {
                aiModelsListEl.innerHTML = '<div style="color:#64748b; font-size:13px; text-align:center; padding:20px;">暂无模型配置，请点击上方添加</div>';
                return;
            }

            configs.forEach(c => {
                const isActive = (c.id === activeId);
                const card = document.createElement('div');
                card.style.cssText = `
                    background: ${isActive ? '#f0fdf4' : '#fff'};
                    border: 1px solid ${isActive ? '#10b981' : '#e2e8f0'};
                    border-radius: 12px; padding: 16px; display:flex; justify-content:space-between; align-items:flex-start;
                    transition:all 0.2s; box-shadow:0 1px 2px rgba(0,0,0,0.02); position:relative; overflow:hidden;
                `;

                card.innerHTML = `
                    <div style="flex:1;">
                        <div style="display:flex; align-items:center; gap:8px; margin-bottom:8px;">
                            <span style="font-size:15px; font-weight:700; color:#1e293b;">${escapeHtml(c.name)}</span>
                            ${isActive ? '<span style="font-size:11px; padding:2px 8px; background:#10b981; color:#fff; border-radius:12px;">✨ 当前使用</span>' : ''}
                        </div>
                        <div style="font-size:12px; color:#475569; margin-bottom:4px;"><strong style="color:#64748b;">Model:</strong> ${escapeHtml(c.model)}</div>
                        <div style="font-size:11px; color:#94a3b8; font-family:monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:350px;"><strong style="color:#64748b; font-family:sans-serif;">Base URL:</strong> ${escapeHtml(c.url)}</div>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        ${!isActive ? `<button class="ds-btn ds-ai-btn-activate" data-id="${c.id}" style="padding:6px 12px; font-size:12px; background:#3b82f6; color:#fff; border-radius:6px; border:none; cursor:pointer;">启用</button>` : ''}
                        <button class="ds-btn ds-ai-btn-edit" data-id="${c.id}" style="padding:6px 10px; font-size:12px; background:#f1f5f9; color:#475569; border-radius:6px; border:1px solid #e2e8f0; cursor:pointer;">编辑</button>
                        <button class="ds-btn ds-ai-btn-del" data-id="${c.id}" style="padding:6px 10px; font-size:12px; background:#fef2f2; color:#ef4444; border-radius:6px; border:1px solid #fca5a5; cursor:pointer;">删除</button>
                    </div>
                `;

                if(!isActive) card.querySelector('.ds-ai-btn-activate').addEventListener('click', () => {
                    localStorage.setItem('ds_ai_active_id', c.id);
                    renderAIModels();
                });

                card.querySelector('.ds-ai-btn-edit').addEventListener('click', () => {
                    aiFormTitle.textContent = '编辑模型配置';
                    aiFormId.value = c.id;
                    aiFormName.value = c.name;
                    aiFormUrl.value = c.url;
                    aiFormKey.value = c.key;
                    aiFormModel.value = c.model;
                    aiPresetSelect.value = '';
                    aiFormStatus.style.display = 'none';
                    aiFormWrap.style.display = 'block';
                    aiFormWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                });

                card.querySelector('.ds-ai-btn-del').addEventListener('click', () => {
                    if(!confirm(`确定要删除配置 "${c.name}" 吗？`)) return;
                    let { configs, activeId } = loadAIConfigs();
                    configs = configs.filter(x => x.id !== c.id);
                    if (activeId === c.id) localStorage.removeItem('ds_ai_active_id');
                    localStorage.setItem('ds_ai_configs', JSON.stringify(configs));
                    if (aiFormId.value === c.id) aiFormWrap.style.display = 'none';
                    renderAIModels();
                });

                aiModelsListEl.appendChild(card);
            });
        }

        // 初始渲染
        renderAIModels();

        overlay.querySelector('#ds-ai-add-model-btn').addEventListener('click', () => {
            aiFormTitle.textContent = '新增模型配置';
            aiFormId.value = '';
            aiFormName.value = '';
            aiFormUrl.value = '';
            aiFormKey.value = '';
            aiFormModel.value = '';
            aiPresetSelect.value = '';
            aiFormStatus.style.display = 'none';
            aiFormWrap.style.display = 'block';
            aiFormWrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        });

        overlay.querySelector('#ds-ai-form-cancel').addEventListener('click', () => {
            aiFormWrap.style.display = 'none';
        });

        aiPresetSelect.addEventListener('change', (e) => {
            const v = e.target.value;
            if (v === 'deepseek') { aiFormName.value = 'DeepSeek 官方'; aiFormUrl.value = 'https://api.deepseek.com/v1/chat/completions'; aiFormModel.value = 'deepseek-chat'; }
            else if (v === 'siliconflow') { aiFormName.value = '硅基流动 (SiliconFlow)'; aiFormUrl.value = 'https://api.siliconflow.cn/v1/chat/completions'; aiFormModel.value = 'deepseek-ai/DeepSeek-V3'; }
            else if (v === 'dashscope') { aiFormName.value = '阿里云百炼'; aiFormUrl.value = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'; aiFormModel.value = 'deepseek-v3'; }
        });

        overlay.querySelector('#ds-ai-save-btn').addEventListener('click', () => {
            const name = aiFormName.value.trim() || '未命名配置';
            const url = aiFormUrl.value.trim();
            const key = aiFormKey.value.trim();
            const model = aiFormModel.value.trim();

            if (!url || !key || !model) {
                aiFormStatus.textContent = '❌ 请完整填写 URL、Key 和 Model';
                aiFormStatus.style.color = '#ef4444';
                aiFormStatus.style.background = '#fef2f2';
                aiFormStatus.style.display = 'inline-block';
                return;
            }

            let { configs, activeId } = loadAIConfigs();
            const editId = aiFormId.value;

            if (editId) {
                const match = configs.find(c => c.id === editId);
                if(match) { match.name = name; match.url = url; match.key = key; match.model = model; }
            } else {
                const newId = Date.now().toString();
                configs.unshift({ id: newId, name, url, key, model });
                if(configs.length === 1) localStorage.setItem('ds_ai_active_id', newId); // 自动激活第一个
            }

            localStorage.setItem('ds_ai_configs', JSON.stringify(configs));
            aiFormWrap.style.display = 'none';
            renderAIModels();
        });

        overlay.querySelector('#ds-ai-test-btn').addEventListener('click', async () => {
            const url = aiFormUrl.value.trim();
            const key = aiFormKey.value.trim();
            const model = aiFormModel.value.trim();
            if (!url || !key || !model) {
                aiFormStatus.textContent = '❌ 测试前请填写完整';
                aiFormStatus.style.color = '#ef4444'; aiFormStatus.style.background = '#fef2f2'; aiFormStatus.style.display = 'inline-block';
                return;
            }

            aiFormStatus.textContent = '⏳ 正在测试...';
            aiFormStatus.style.color = '#64748b'; aiFormStatus.style.background = '#f8fafc'; aiFormStatus.style.display = 'inline-block';
            overlay.querySelector('#ds-ai-test-btn').disabled = true;

            try {
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
                    body: JSON.stringify({ model: model, messages: [{ role: 'user', content: 'Ping! Return "Pong" if you receive this.' }], max_tokens: 10 })
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                const reply = data?.choices?.[0]?.message?.content || '';
                aiFormStatus.textContent = `✅ 测试成功: ${reply.substring(0, 10)}`;
                aiFormStatus.style.color = '#10b981'; aiFormStatus.style.background = '#f0fdf4';
            } catch(e) {
                aiFormStatus.textContent = `❌ 失败: ${e.message}`;
                aiFormStatus.style.color = '#ef4444'; aiFormStatus.style.background = '#fef2f2';
            } finally {
                overlay.querySelector('#ds-ai-test-btn').disabled = false;
            }
        });

        // 获取当前活动 AI 配置的辅助函数 (供其他模块使用)
        window.__dsGetActiveAIConfig = () => {
            const { configs, activeId } = loadAIConfigs();
            return configs.find(c => c.id === activeId) || {};
        };

        const aiFetchModelsBtn = overlay.querySelector('#ds-ai-fetch-models-btn');
        const fetchedWrap = overlay.querySelector('#ds-fetched-models-wrap');
        const fetchedStatus = overlay.querySelector('#ds-fetched-models-status');
        const fetchedList = overlay.querySelector('#ds-fetched-models-list');

        if (aiFetchModelsBtn) {
            aiFetchModelsBtn.addEventListener('click', async () => {
                let url = aiFormUrl.value.trim();
                const key = aiFormKey.value.trim();
                if (!url) return dsAlert('请先填写 Base URL', 'warning');
                if (!key) return dsAlert('请先填写 API Key', 'warning');

                if (url.endsWith('/chat/completions')) url = url.replace('/chat/completions', '/models');
                else if (!url.endsWith('/models')) url = url.endsWith('/') ? url + 'models' : url + '/models';

                fetchedWrap.style.display = 'block';
                fetchedStatus.textContent = '正在获取模型列表...';
                fetchedStatus.style.color = '#3b82f6';
                fetchedList.innerHTML = '';
                aiFetchModelsBtn.disabled = true;

                try {
                    const resp = await fetch(url, { method: 'GET', headers: { 'Authorization': `Bearer ${key}` } });
                    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                    const data = await resp.json();
                    let models = data?.data || data?.models || [];
                    if (!Array.isArray(models)) {
                        if (Array.isArray(data)) models = data;
                        else throw new Error('接口返回格式无法解析');
                    }
                    if (models.length === 0) throw new Error('模型列表为空');

                    fetchedStatus.textContent = `✅ 已加载 ${models.length} 个模型。点击即可填入。`;
                    fetchedStatus.style.color = '#10b981';

                    const df = document.createDocumentFragment();
                    models.forEach(m => {
                        const id = m.id || m.name || m;
                        const tag = document.createElement('span');
                        tag.style.cssText = 'padding:4px 10px; background:#f1f5f9; border:1px solid #cbd5e1; border-radius:12px; font-size:12px; color:#334155; cursor:pointer; transition:all 0.2s; white-space:nowrap;';
                        tag.textContent = id;
                        tag.onmouseover = () => { tag.style.borderColor = '#3b82f6'; tag.style.color = '#3b82f6'; };
                        tag.onmouseout = () => { tag.style.borderColor = '#cbd5e1'; tag.style.color = '#334155'; };
                        tag.onclick = () => {
                            aiFormModel.value = id;
                            fetchedWrap.style.display = 'none';
                        };
                        df.appendChild(tag);
                    });
                    fetchedList.appendChild(df);
                } catch(e) {
                    fetchedStatus.textContent = `❌ 获取失败: ${e.message}`;
                    fetchedStatus.style.color = '#ef4444';
                } finally {
                    aiFetchModelsBtn.disabled = false;
                }
            });
        }

        // 按 Escape 关闭
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && !isRunning && overlay.style.display === 'block') {
                overlay.style.display = 'none';
            }
        });

        // ==================== UI Logic Enhancements ====================
        // 1. Danger Wipe Logic
        document.getElementById('ds-danger-wipe-btn').addEventListener('click', async () => {
            const select = document.getElementById('ds-danger-wipe-select');
            const mode = select.value;
            if (mode === 'none') {
                dsAlert('请先选择要执行的危险操作', 'warning');
                return;
            }

            if (mode === 'global') {
                if (await dsConfirm('确定要清空全局标签组吗？所有配置的颜色和快捷标签将被删除。')) {
                    localStorage.removeItem('ds_global_tags');
                    window.__dsGlobalTags = [];
                    const globalTagsPool = document.getElementById('ds-global-tags-pool');
                    const bulkTagNameInput = document.getElementById('ds-bulk-tag-name');
                    const bulkTagColorSelect = document.getElementById('ds-bulk-tag-color');
                    const tagSearchInp = document.getElementById('ds-tag-search-inp');
                    if (globalTagsPool) {
                        renderGlobalTags(globalTagsPool, (name, color) => {
                            if (bulkTagNameInput) bulkTagNameInput.value = name;
                            if (bulkTagColorSelect) bulkTagColorSelect.value = color;
                        }, tagSearchInp ? tagSearchInp.value.trim() : '');
                    }
                    dsAlert('全局标签组已清空');
                }
            } else if (mode === 'all_sessions') {
                if (await dsConfirm('确定要擦除【所有缓存会话】的标签吗？')) {
                    localStorage.removeItem('ds_local_tags');
                    window.__dsLocalTags = {};
                    renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
                    dsAlert('所有会话标签已擦除');
                }
            } else if (mode === 'selected_sessions') {
                const checkedCbs = Array.from(document.querySelectorAll('.ds-session-cb:checked'));
                if (checkedCbs.length === 0) return dsAlert('列表中没有勾选的会话', 'warning');
                if (await dsConfirm(`确定要擦除当前选中的 ${checkedCbs.length} 个会话的标签吗？`)) {
                    checkedCbs.forEach(cb => {
                        const id = cb.value;
                        delete window.__dsLocalTags[id];
                    });
                    localStorage.setItem('ds_local_tags', JSON.stringify(window.__dsLocalTags));
                    // 强制手动重绘以防缓存延迟
                    if (typeof renderResultList === 'function' && typeof matchedSessions !== 'undefined') {
                        renderResultList(matchedSessions, resultList, resultCount, selectAllCb);
                    }
                    dsAlert(`已擦除 ${checkedCbs.length} 个会话的标签`);
                }
            }
            select.value = 'none';
        });

        // 2. Advanced Selection Bar (Tag Chips Edition)

        document.getElementById('ds-select-invert-btn').addEventListener('click', () => {
            const cbs = document.querySelectorAll('#ds-local-pane .ds-session-cb:not(:disabled)');
            cbs.forEach(cb => cb.checked = !cb.checked);
            updateSelectAllState();
            if (window.__dsUpdateExportPane) window.__dsUpdateExportPane();
        });

        document.getElementById('ds-select-clear-btn-ai')?.addEventListener('click', () => {
            document.querySelectorAll('#ds-ai-pane .ds-session-cb:checked').forEach(cb => cb.checked = false);
            if (typeof updateSelectAllStateAi === 'function') updateSelectAllStateAi();
            if (window.__dsUpdateExportPane) window.__dsUpdateExportPane();
        });

        window.__dsPopulateSelectByTag = () => {
            const cont = document.getElementById('ds-tag-chips-container');
            if(!cont) return;

            const tagMap = new Map();
            // Merge global tags first to maintain color mapping
            window.__dsGlobalTags.forEach(t => tagMap.set(t.name, t.color));
            // Add local tags if missing
            Object.values(window.__dsLocalTags || {}).forEach(arr => arr.forEach(t => {
                if(!tagMap.has(t.name)) tagMap.set(t.name, t.color || '#3b82f6');
            }));

            const tagsData = Array.from(tagMap.entries()).map(([name, color]) => ({name, color}));
            
            const renderChips = (container, isLocal) => {
                if(!container) return;
                container.innerHTML = '';
                if(tagsData.length === 0) {
                    container.innerHTML = '<span style="font-size:11px; color:#94a3b8;">暂无标签数据</span>';
                    return;
                }
                
                tagsData.forEach(t => {
                    const chip = document.createElement('span');
                    chip.style.cssText = `padding:4px 12px; border-radius:14px; background:${t.color}; color:#fff; font-size:11px; font-weight:500; cursor:pointer; opacity:0.8; transition:all 0.2s; user-select:none; display:inline-block; box-shadow:0 1px 3px rgba(0,0,0,0.12);`;
                    chip.textContent = t.name;
                    chip.onmouseover = () => chip.style.opacity = '1';
                    chip.onmouseout = () => chip.style.opacity = '0.8';
                    chip.onclick = () => {
                        chip.style.transform = 'scale(0.92)';
                        setTimeout(() => chip.style.transform = 'scale(1)', 100);
                        
                        const paneSelector = isLocal ? '#ds-local-pane' : '#ds-ai-pane';
                        const cbs = document.querySelectorAll(`${paneSelector} .ds-session-cb`);
                        
                        // 智能全选检测：如果当前列表的所有项都是选中状态，则此时点击标签为“排他性单选”
                        const allCheckedGlobally = cbs.length > 0 && Array.from(cbs).every(cb => cb.checked);
                        if (allCheckedGlobally) {
                            cbs.forEach(cb => cb.checked = false);
                        }
                        
                        // 多选反转逻辑
                        const targetCbs = Array.from(cbs).filter(cb => {
                            const sessionTags = window.__dsLocalTags[cb.value] || [];
                            return sessionTags.some(tag => tag.name === t.name);
                        });
                        
                        if (targetCbs.length > 0) {
                            const allChecked = targetCbs.every(cb => cb.checked);
                            targetCbs.forEach(cb => cb.checked = !allChecked);
                        }
                        
                        if (isLocal) updateSelectAllState();
                        else if (typeof updateSelectAllStateAi === 'function') updateSelectAllStateAi();
                        if (window.__dsUpdateExportPane) window.__dsUpdateExportPane();
                    };
                    container.appendChild(chip);
                });
            };
            
            renderChips(cont, true);
        };
        
        const _origSaveTags = window.saveTags;
        window.saveTags = function() { if(_origSaveTags) _origSaveTags(); if(window.__dsSyncTagUI) window.__dsSyncTagUI(); };
        setTimeout(() => { if(window.__dsSyncTagUI) window.__dsSyncTagUI(); }, 100);

        // 3. AI Model Presets
        document.getElementById('ds-ai-preset-select').addEventListener('change', (e) => {
            const val = e.target.value;
            const urlInp = document.getElementById('ds-ai-url');
            const modelInp = document.getElementById('ds-ai-model');
            if (val === 'deepseek') { urlInp.value = 'https://api.deepseek.com/v1/chat/completions'; modelInp.value = 'deepseek-chat'; }
            else if (val === 'openai') { urlInp.value = 'https://api.openai.com/v1/chat/completions'; modelInp.value = 'gpt-4o'; }
            else if (val === 'gemini') { urlInp.value = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions'; modelInp.value = 'gemini-1.5-pro'; }
            else if (val === 'claude') { urlInp.value = 'https://api.anthropic.com/v1/messages'; modelInp.value = 'claude-3-5-sonnet-20240620'; }
            else if (val === 'kimi') { urlInp.value = 'https://api.moonshot.cn/v1/chat/completions'; modelInp.value = 'moonshot-v1-8k'; }
            else if (val === 'siliconflow') { urlInp.value = 'https://api.siliconflow.cn/v1/chat/completions'; modelInp.value = 'deepseek-ai/DeepSeek-V2.5'; }
            else if (val === 'dashscope') { urlInp.value = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'; modelInp.value = 'qwen-max'; }
        });

        // 4. Tag Sorting
        document.getElementById('ds-tag-sort-select').addEventListener('change', (e) => {
            const mode = e.target.value;
            let tags = getGlobalTags();
            if (mode === 'az') {
                tags.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN', {sensitivity: 'accent'}));
            } else if (mode === 'color') {
                tags.sort((a, b) => a.color.localeCompare(b.color));
            } else {
                tags = JSON.parse(localStorage.getItem('ds_global_tags') || '[]');
            }
            
            localStorage.setItem('ds_global_tags', JSON.stringify(tags));
            
            const globalTagsPool = document.getElementById('ds-global-tags-pool');
            const tagSearchInp = document.getElementById('ds-tag-search-inp');
            const bulkTagNameInput = document.getElementById('ds-bulk-tag-name');
            const bulkTagColorSelect = document.getElementById('ds-bulk-tag-color');
            
            if (globalTagsPool) {
                renderGlobalTags(globalTagsPool, (name, color) => {
                    if (bulkTagNameInput) bulkTagNameInput.value = name;
                    if (bulkTagColorSelect) bulkTagColorSelect.value = color;
                }, tagSearchInp ? tagSearchInp.value.trim() : '');
            }
        });
    }

    // ==================== 挂载入口（SPA 兼容） ====================
    // DeepSeek 使用 SPA 架构，用轮询确保按钮在页面跳转后依然存在
    let mounted = false;

    function tryMount() {
        if (mounted && document.getElementById('ds-bulk-btn')) return;
        if (!document.body) return;

        // 清理旧实例（路由跳转后）
        const old = document.getElementById('ds-bulk-btn');
        if (old) old.remove();
        const oldOverlay = document.getElementById('ds-bulk-overlay');
        if (oldOverlay) oldOverlay.remove();

        buildUI();
        mounted = true;
    }

    // 首次挂载
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', tryMount);
    } else {
        tryMount();
    }

    // SPA 路由变化监听：轮询 + History API 拦截
    setInterval(() => {
        if (!document.getElementById('ds-bulk-btn')) {
            mounted = false;
            tryMount();
        }
    }, 1500);

    // 监听 pushState / replaceState（SPA 路由）
    const _push = history.pushState.bind(history);
    const _replace = history.replaceState.bind(history);
    history.pushState = function (...args) { _push(...args); setTimeout(tryMount, 600); };
    history.replaceState = function (...args) { _replace(...args); setTimeout(tryMount, 600); };
    window.addEventListener('popstate', () => setTimeout(tryMount, 600));

    // ==================== 8. 原生无缝融合：内嵌提示词切换下拉菜单 ====================
    const InlinePromptUI = {
        btnId: 'ds-inline-prompt-btn',
        dropdownId: 'ds-inline-dropdown',

        init() {
            if (!document.getElementById(this.dropdownId)) {
                const dp = document.createElement('div');
                dp.id = this.dropdownId;
                dp.style.cssText = 'position:fixed; background:#ffffff; border:1px solid #e2e8f0; border-radius:12px; padding:6px; display:none; flex-direction:column; gap:2px; min-width:180px; max-width:280px; box-shadow:0 12px 32px rgba(0,0,0,0.1); z-index:2147483647; max-height:300px; overflow-y:auto;';
                document.body.appendChild(dp);

                document.addEventListener('click', (e) => {
                    const btn = document.getElementById(this.btnId);
                    if (dp.style.display === 'flex' && !dp.contains(e.target) && (!btn || !btn.contains(e.target))) {
                        dp.style.display = 'none';
                    }
                });
            }
        },

        mount() {
            // 通过广度查询包含 "深度思考" 的文本节点，抛弃对特定类名的依赖
            const allElements = document.querySelectorAll('div[role="button"], div[role="switch"], button, div.ds-toggle-button, div[role="checkbox"]');
            const anchorBtn = Array.from(allElements).find(b => b.textContent && (b.textContent.includes('深度思考') || b.textContent.includes('联网搜索')));

            if (!anchorBtn) return;

            const container = anchorBtn.parentElement;
            let btn = document.getElementById(this.btnId);

            if (!btn) {
                btn = document.createElement('div');
                btn.id = this.btnId;
                btn.className = 'ds-atom-button f79352dc ds-toggle-button ds-toggle-button--md';
                btn.setAttribute('role', 'button');
                btn.setAttribute('tabindex', '0');
                btn.innerHTML = `
                    <div class="ds-icon ds-atom-button__icon" style="font-size: 14px; width: 14px; height: 14px; margin-right: 0px;">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                        </svg>
                    </div>
                    <span><span class="_6dbc175 ds-inline-btn-text" style="color: inherit;">系统指令</span></span>
                    <div class="ds-focus-ring"></div>
                `;
                btn.onclick = (e) => { e.preventDefault(); e.stopPropagation(); this.toggleDropdown(btn); };
            }

            const nativeToggles = Array.from(container.children).filter(c => c.classList.contains('ds-toggle-button') && c.id !== this.btnId);
            const lastNative = nativeToggles[nativeToggles.length - 1];

            if (lastNative && lastNative.nextSibling !== btn) {
                container.insertBefore(btn, lastNative.nextSibling);
            } else if (!lastNative && !container.contains(btn)) {
                container.appendChild(btn);
            }
            this.update();
        },

        update() {
            const btn = document.getElementById(this.btnId);
            if (!btn) return;
            const textEl = btn.querySelector('.ds-inline-btn-text');
            const arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
            const enabled = arr.filter(p => p.enabled);

            if (enabled.length === 0) {
                btn.classList.remove('ds-toggle-button--selected');
                textEl.textContent = '未启用指令';
            } else {
                btn.classList.add('ds-toggle-button--selected');
                textEl.textContent = enabled.length === 1 ? enabled[0].name : `指令(${enabled.length})`;
            }
        },

        toggleDropdown(btnEl) {
            const dp = document.getElementById(this.dropdownId);
            if (!dp) return;
            if (dp.style.display === 'flex') { dp.style.display = 'none'; return; }

            const arr = JSON.parse(localStorage.getItem(LS_PROMPTS) || '[]');
            dp.innerHTML = '';
            if (!arr.length) {
                dp.innerHTML = '<div style="padding:12px; color:#64748b; font-size:13px; text-align:center;">请在增强套件中配置系统提示词</div>';
            } else {
                arr.forEach(p => {
                    const item = document.createElement('div');
                    item.style.cssText = `padding:8px 12px; border-radius:8px; cursor:pointer; font-size:13px; display:flex; align-items:center; gap:8px; color:${p.enabled ? '#1e293b' : '#64748b'}; background:${p.enabled ? '#f0f9ff' : 'transparent'};`;
                    item.innerHTML = `
                        <div style="width:16px; height:16px; border-radius:4px; border:1px solid ${p.enabled ? '#3b82f6' : '#cbd5e1'}; background:${p.enabled ? '#3b82f6' : 'transparent'}; display:flex; align-items:center; justify-content:center;">
                            ${p.enabled ? '<svg width="10" height="10" viewBox="0 0 12 12" fill="none"><path d="M2 6L5 9L10 3" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>' : ''}
                        </div>
                        <span style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${p.name}</span>
                    `;
                    item.onclick = (e) => {
                        e.stopPropagation();
                        p.enabled = !p.enabled;
                        localStorage.setItem(LS_PROMPTS, JSON.stringify(arr));
                        this.toggleDropdown(btnEl);
                        this.update();
                    };
                    item.onmouseenter = () => { if(!p.enabled) item.style.background = '#f8fafc'; };
                    item.onmouseleave = () => { if(!p.enabled) item.style.background = 'transparent'; };
                    dp.appendChild(item);
                });
            }
            const rect = btnEl.getBoundingClientRect();
            dp.style.left = `${rect.left}px`;
            dp.style.bottom = `${window.innerHeight - rect.top + 8}px`;
            dp.style.display = 'flex';
        }
    };

    InlinePromptUI.init();

    // 初始化渲染提示词
    if (typeof renderPrompts === 'function') renderPrompts();

    // 监听输入框区域的 DOM 变化，防止被 React 冲刷掉
    let mountTimer = null;
    const domObserver = new MutationObserver(() => {
        if (mountTimer) clearTimeout(mountTimer);
        mountTimer = setTimeout(() => InlinePromptUI.mount(), 50);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });

    }); // end waitForDOM
})();