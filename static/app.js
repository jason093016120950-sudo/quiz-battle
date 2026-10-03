// Quiz Battle Client Application Logic

class QuizApp {
    constructor() {
        this.role = null; // 'host' | 'player'
        this.pin = null;
        this.hostId = null;
        this.playerId = null;
        this.nickname = null;
        this.ws = null;
        this.timerInterval = null;
        this.remainingSeconds = 20;
        this.hasAnswered = false;
        this.selectedOption = null;
        this.currentQuestionData = null;
        this.isSoundEnabled = true;

        this.publicUrl = null;
        this.lanUrl = null;
        this.customUrl = null;
        this.networkMode = 'public'; // 'public' | 'lan' | 'custom'

        this.init();
    }

    init() {
        // Parse URL params (e.g. ?pin=123456)
        const urlParams = new URLSearchParams(window.location.search);
        const pinFromUrl = urlParams.get('pin');
        if (pinFromUrl) {
            const inputPin = document.getElementById('input-pin');
            if (inputPin) {
                inputPin.value = pinFromUrl;
                document.getElementById('input-nickname').focus();
            }
        }

        // Check local storage for session restoration
        this.checkExistingSession();
    }

    checkExistingSession() {
        const savedRole = localStorage.getItem('qb_role');
        const savedPin = localStorage.getItem('qb_pin');
        const savedPlayerId = localStorage.getItem('qb_player_id');
        const savedHostId = localStorage.getItem('qb_host_id');
        const savedNickname = localStorage.getItem('qb_nickname');

        if (savedRole === 'player' && savedPin && savedPlayerId) {
            // Player might be reconnecting
            this.role = 'player';
            this.pin = savedPin;
            this.playerId = savedPlayerId;
            this.nickname = savedNickname;
            this.connectWebSocket(() => {
                this.sendWS({
                    type: 'player_reconnect',
                    pin: this.pin,
                    player_id: this.playerId
                });
            });
        } else if (savedRole === 'host' && savedPin && savedHostId) {
            // Host might be reconnecting
            this.role = 'host';
            this.pin = savedPin;
            this.hostId = savedHostId;
            this.connectWebSocket(() => {
                this.sendWS({
                    type: 'host_reconnect',
                    pin: this.pin,
                    host_id: this.hostId
                });
            });
        }
    }

    switchView(viewId) {
        document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
        const target = document.getElementById(viewId);
        if (target) {
            target.classList.add('active');
            window.scrollTo(0, 0);
        }

        // Toggle host-only controls visibility
        const hostOnlyEls = document.querySelectorAll('.host-only');
        hostOnlyEls.forEach(el => {
            if (this.role === 'host') {
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
            }
        });
    }

    showToast(message, duration = 3000) {
        const box = document.getElementById('toast-box');
        if (!box) return;
        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.innerText = message;
        box.appendChild(toast);
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, duration);
    }

    toggleSound() {
        if (window.soundEngine) {
            this.isSoundEnabled = window.soundEngine.toggle();
            document.getElementById('sound-icon').innerText = this.isSoundEnabled ? '🔊' : '🔇';
            this.showToast(this.isSoundEnabled ? '音效已開啟' : '音效已靜音');
        }
    }

    connectWebSocket(onOpenCallback) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            if (onOpenCallback) onOpenCallback();
            return;
        }

        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);

        this.ws.onopen = () => {
            console.log("WebSocket connected to", wsUrl);
            if (onOpenCallback) onOpenCallback();
        };

        this.ws.onmessage = (event) => {
            try {
                const data = jsonParse(event.data);
                this.handleServerMessage(data);
            } catch (err) {
                console.error("Message parse error:", err);
            }
        };

        this.ws.onclose = () => {
            console.warn("WebSocket closed");
        };

        this.ws.onerror = (err) => {
            console.error("WebSocket error:", err);
        };
    }

    sendWS(obj) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(obj));
        } else {
            console.warn("WebSocket not ready. Message queued or dropped:", obj);
        }
    }

    // ----------------- User Actions -----------------

    startAsHost() {
        this.role = 'host';
        localStorage.setItem('qb_role', 'host');
        this.connectWebSocket(() => {
            this.sendWS({ type: 'create_room' });
        });
    }

    joinAsPlayer(event) {
        event.preventDefault();
        const pinInput = document.getElementById('input-pin').value.trim();
        const nicknameInput = document.getElementById('input-nickname').value.trim();

        if (!pinInput || pinInput.length < 5) {
            this.showToast("請輸入正確的 6 位數 Game PIN");
            return;
        }
        if (!nicknameInput) {
            this.showToast("請輸入暱稱");
            return;
        }

        this.role = 'player';
        this.pin = pinInput;
        this.nickname = nicknameInput;
        localStorage.setItem('qb_role', 'player');
        localStorage.setItem('qb_pin', this.pin);
        localStorage.setItem('qb_nickname', this.nickname);

        const savedPlayerId = localStorage.getItem('qb_player_id') || '';

        this.connectWebSocket(() => {
            this.sendWS({
                type: 'join_room',
                pin: this.pin,
                nickname: this.nickname,
                player_id: savedPlayerId
            });
        });
    }

    hostStartGame() {
        if (this.role !== 'host') return;
        this.sendWS({ type: 'start_game' });
    }

    hostEndQuestionEarly() {
        if (this.role !== 'host') return;
        this.sendWS({ type: 'end_question_early' });
    }

    hostNextQuestion() {
        if (this.role !== 'host') return;
        this.sendWS({ type: 'next_question' });
    }

    hostPlayAgain() {
        if (this.role !== 'host') return;
        this.sendWS({ type: 'play_again' });
    }

    submitOption(optionLetter) {
        if (this.hasAnswered) return;
        this.hasAnswered = true;
        this.selectedOption = optionLetter;

        // Visual and sound feedback
        if (window.soundEngine) window.soundEngine.playSubmit();

        // Lock button highlights
        document.querySelectorAll('.opt-btn').forEach(btn => btn.classList.add('disabled'));
        const lockedOverlay = document.getElementById('player-locked-overlay');
        const lockedBadge = document.getElementById('locked-choice-badge');
        if (lockedBadge) lockedBadge.innerText = optionLetter;
        if (lockedOverlay) lockedOverlay.classList.remove('hidden');

        // Send to server
        this.sendWS({
            type: 'submit_answer',
            option: optionLetter
        });
    }

    copyPin() {
        if (!this.pin) return;
        navigator.clipboard.writeText(this.pin).then(() => {
            this.showToast(`Game PIN「${this.pin}」已複製到剪貼簿！`);
        }).catch(() => {
            this.showToast(`Game PIN: ${this.pin}`);
        });
    }

    goHome() {
        localStorage.removeItem('qb_role');
        localStorage.removeItem('qb_pin');
        localStorage.removeItem('qb_player_id');
        localStorage.removeItem('qb_host_id');
        window.location.href = '/';
    }

    // ----------------- Network Mode & QR Management -----------------

    setNetworkMode(mode) {
        this.networkMode = mode;
        ['public', 'lan', 'custom'].forEach(m => {
            const btn = document.getElementById(`net-btn-${m}`);
            if (btn) {
                if (m === mode) btn.classList.add('active');
                else btn.classList.remove('active');
            }
        });

        const customBox = document.getElementById('custom-url-box');
        if (customBox) {
            if (mode === 'custom') {
                customBox.classList.remove('hidden');
                document.getElementById('custom-url-input').focus();
            } else {
                customBox.classList.add('hidden');
            }
        }

        this.updateQrCode();
    }

    onCustomUrlInput(val) {
        this.customUrl = val.trim();
        this.updateQrCode();
    }

    copyJoinUrl() {
        const joinUrlEl = document.getElementById('host-join-url');
        if (!joinUrlEl) return;
        const text = joinUrlEl.innerText;
        if (!text || text.includes('...')) return;

        navigator.clipboard.writeText(text).then(() => {
            this.showToast("已複製遊戲加入連結！");
        }).catch(() => {
            this.showToast(text);
        });
    }

    updateQrCode() {
        if (!this.pin) return;

        let base = null;
        const spinner = document.getElementById('qr-loading-spinner');

        if (this.networkMode === 'public') {
            if (this.publicUrl) {
                base = this.publicUrl;
                if (spinner) spinner.classList.add('hidden');
            } else {
                if (spinner) spinner.classList.remove('hidden');
                base = this.lanUrl || window.location.origin;
            }
        } else if (this.networkMode === 'lan') {
            if (spinner) spinner.classList.add('hidden');
            base = this.lanUrl || window.location.origin;
        } else if (this.networkMode === 'custom') {
            if (spinner) spinner.classList.add('hidden');
            base = this.customUrl || window.location.origin;
        }

        // Critical safety: never use localhost or 127.0.0.1 in QR code when LAN IP or Public URL is available!
        if (base && (base.includes('localhost') || base.includes('127.0.0.1'))) {
            if (this.publicUrl) {
                base = this.publicUrl;
            } else if (this.lanUrl) {
                base = this.lanUrl;
            }
        }

        if (!base) base = window.location.origin;
        base = base.replace(/\/+$/, '');

        const joinUrl = `${base}/?pin=${this.pin}`;

        const qrImg = document.getElementById('host-qr-img');
        if (qrImg) {
            qrImg.src = `/api/qrcode?text=${encodeURIComponent(joinUrl)}`;
        }
        const joinUrlEl = document.getElementById('host-join-url');
        if (joinUrlEl) {
            joinUrlEl.innerText = joinUrl;
            joinUrlEl.title = joinUrl;
        }
    }

    // ----------------- Message Handling -----------------

    handleServerMessage(msg) {
        console.log("WS Recv:", msg.type, msg);

        switch (msg.type) {
            case 'room_created':
                this.onRoomCreated(msg);
                break;

            case 'public_url_ready':
                this.publicUrl = msg.public_url;
                this.updateQrCode();
                this.showToast("🌐 雲端公網連線已就緒！");
                break;

            case 'host_reconnected':
                this.onHostReconnected(msg);
                break;

            case 'join_success':
                this.onJoinSuccess(msg);
                break;

            case 'player_reconnected':
                this.onPlayerReconnected(msg);
                break;

            case 'join_error':
            case 'error':
                this.showToast(msg.message || "發生錯誤");
                break;

            case 'player_list_update':
                this.onPlayerListUpdate(msg);
                break;

            case 'player_status_change':
                this.onPlayerStatusChange(msg);
                break;

            case 'countdown':
                this.onCountdown(msg);
                break;

            case 'question_start':
                this.onQuestionStart(msg);
                break;

            case 'answer_update':
                this.onAnswerUpdate(msg);
                break;

            case 'answer_locked':
                // Confirmed locked by server
                break;

            case 'question_result':
                this.onQuestionResult(msg);
                break;

            case 'game_over':
                this.onGameOver(msg);
                break;

            case 'game_reset':
                this.onGameReset(msg);
                break;

            case 'reconnect_failed':
                localStorage.removeItem('qb_role');
                localStorage.removeItem('qb_pin');
                this.switchView('view-home');
                this.showToast(msg.message || "連線已過期，請重新加入");
                break;
        }
    }

    onRoomCreated(data) {
        this.pin = data.pin;
        this.hostId = data.host_id;
        localStorage.setItem('qb_host_id', this.hostId);
        localStorage.setItem('qb_pin', this.pin);

        document.getElementById('nav-pin-val').innerText = this.pin;
        document.getElementById('room-pin-badge').classList.remove('hidden');
        document.getElementById('host-pin-val').innerText = this.pin;

        if (data.public_url) {
            this.publicUrl = data.public_url;
        }
        if (data.lan_ip) {
            this.lanUrl = `http://${data.lan_ip}:8000`;
        } else {
            this.lanUrl = `http://192.168.31.72:8000`;
        }

        this.updateQrCode();
        this.switchView('view-host-lobby');
    }

    onHostReconnected(data) {
        this.pin = data.pin;
        document.getElementById('nav-pin-val').innerText = this.pin;
        document.getElementById('room-pin-badge').classList.remove('hidden');
        this.showToast("已恢復主持人連線");

        if (data.public_url) this.publicUrl = data.public_url;
        if (data.lan_ip) this.lanUrl = `http://${data.lan_ip}:8000`;
        this.updateQrCode();

        if (data.state === 'LOBBY') {
            this.onRoomCreated({ pin: this.pin, host_id: this.hostId, public_url: this.publicUrl, lan_ip: data.lan_ip });
            this.onPlayerListUpdate({ players: data.players, count: data.players.length });
        } else if (data.state === 'QUESTION' && data.question) {
            this.onQuestionStart(data.question);
        } else if (data.state === 'RESULT' || data.state === 'FINAL') {
            this.switchView('view-host-result');
        }
    }

    onJoinSuccess(data) {
        this.pin = data.pin;
        this.playerId = data.player_id;
        localStorage.setItem('qb_player_id', this.playerId);
        localStorage.setItem('qb_pin', this.pin);

        document.getElementById('player-my-name').innerText = this.nickname;
        document.getElementById('player-my-pin').innerText = this.pin;
        document.getElementById('nav-pin-val').innerText = this.pin;
        document.getElementById('room-pin-badge').classList.remove('hidden');

        this.switchView('view-player-lobby');
    }

    onPlayerReconnected(data) {
        this.pin = data.pin;
        this.playerId = data.player_id;
        this.nickname = data.nickname;

        document.getElementById('player-my-name').innerText = this.nickname;
        document.getElementById('player-my-pin').innerText = this.pin;
        document.getElementById('nav-pin-val').innerText = this.pin;
        document.getElementById('room-pin-badge').classList.remove('hidden');

        this.showToast(`歡迎回來，${this.nickname}！`);

        if (data.state === 'LOBBY') {
            this.switchView('view-player-lobby');
        } else if (data.state === 'QUESTION' && data.question) {
            this.onQuestionStart(data.question);
            if (data.has_answered) {
                this.hasAnswered = true;
                this.selectedOption = data.selected_option;
                document.querySelectorAll('.opt-btn').forEach(btn => btn.classList.add('disabled'));
                const lockedOverlay = document.getElementById('player-locked-overlay');
                const lockedBadge = document.getElementById('locked-choice-badge');
                if (lockedBadge) lockedBadge.innerText = data.selected_option || '✓';
                if (lockedOverlay) lockedOverlay.classList.remove('hidden');
            }
        } else {
            this.switchView('view-player-lobby');
        }
    }

    onPlayerListUpdate(data) {
        const count = data.count || (data.players ? data.players.length : 0);
        const countEl = document.getElementById('host-player-count');
        if (countEl) countEl.innerText = count;

        const startBtn = document.getElementById('btn-start-game');
        if (startBtn) {
            if (count > 0) {
                startBtn.disabled = false;
                startBtn.innerText = `開始遊戲 (${count} 位同學已加入)`;
            } else {
                startBtn.disabled = true;
                startBtn.innerText = "開始遊戲 (等待玩家加入)";
            }
        }

        const grid = document.getElementById('host-player-list');
        if (grid && data.players) {
            if (data.players.length === 0) {
                grid.innerHTML = '<div class="empty-hint">等待台下同學拿出手機加入...</div>';
            } else {
                const emojis = ['🦁', '🐯', '🐼', '🦊', '🐨', '🦄', '🚀', '⭐', '🔥', '👑', '⚡', '💡'];
                grid.innerHTML = data.players.map((p, idx) => {
                    const emoji = emojis[idx % emojis.length];
                    const disClass = p.connected ? '' : 'disconnected';
                    const disText = p.connected ? '' : ' (斷線)';
                    return `<div class="player-chip ${disClass}">${emoji} ${escapeHtml(p.nickname)}${disText}</div>`;
                }).join('');
            }
        }
    }

    onPlayerStatusChange(data) {
        const countEl = document.getElementById('host-player-count');
        if (countEl && data.connected_count !== undefined) {
            countEl.innerText = data.connected_count;
        }
    }

    onCountdown(data) {
        const count = data.count;
        document.getElementById('countdown-num').innerText = count;
        document.getElementById('countdown-qnum').innerText = `第 ${data.question_index} / ${data.total_questions} 題`;

        if (window.soundEngine) {
            window.soundEngine.playCountdown(count);
        }

        this.switchView('view-countdown');
    }

    onQuestionStart(data) {
        this.currentQuestionData = data;
        this.hasAnswered = false;
        this.selectedOption = null;

        // Reset overlays and buttons
        const lockedOverlay = document.getElementById('player-locked-overlay');
        if (lockedOverlay) lockedOverlay.classList.add('hidden');
        document.querySelectorAll('.opt-btn').forEach(btn => btn.classList.remove('disabled'));

        // Update question counter & title
        document.getElementById('q-counter').innerText = `第 ${data.question_index} / ${data.total_questions} 題`;
        document.getElementById('q-title').innerText = data.question;

        // Update question photo (Question 15 special requirement)
        const imgWrap = document.getElementById('q-image-container');
        const imgEl = document.getElementById('q-image');
        if (data.image) {
            imgEl.src = data.image;
            imgWrap.classList.remove('hidden');
        } else {
            imgEl.src = '';
            imgWrap.classList.add('hidden');
        }

        // Set options text
        data.options.forEach(opt => {
            const textEl = document.getElementById(`opt-text-${opt.key}`);
            if (textEl) {
                textEl.innerText = opt.text;
            }
        });

        // Set answered progress
        document.getElementById('q-answered-count').innerText = data.answered_count || 0;
        document.getElementById('q-total-count').innerText = data.total_players || 0;

        // Start Countdown Timer Bar & Ticks
        this.startQuestionTimer(data.time_limit || 20);

        this.switchView('view-question');
    }

    startQuestionTimer(seconds) {
        if (this.timerInterval) clearInterval(this.timerInterval);

        this.remainingSeconds = seconds;
        const totalSeconds = seconds;
        const timerSecondsEl = document.getElementById('timer-seconds');
        const progressBar = document.getElementById('timer-progress-bar');

        timerSecondsEl.innerText = this.remainingSeconds;
        progressBar.style.width = '100%';

        const startTime = Date.now();
        const durationMs = totalSeconds * 1000;

        this.timerInterval = setInterval(() => {
            const elapsedMs = Date.now() - startTime;
            const remainingMs = Math.max(0, durationMs - elapsedMs);
            const remainingSec = Math.ceil(remainingMs / 1000);

            timerSecondsEl.innerText = remainingSec;
            const pct = (remainingMs / durationMs) * 100;
            progressBar.style.width = `${pct}%`;

            if (remainingSec <= 5 && remainingSec > 0 && Math.floor(elapsedMs / 1000) !== Math.floor((elapsedMs - 100) / 1000)) {
                if (window.soundEngine) window.soundEngine.playTick();
            }

            if (remainingMs <= 0) {
                clearInterval(this.timerInterval);
                this.timerInterval = null;
            }
        }, 100);
    }

    onAnswerUpdate(data) {
        const answeredEl = document.getElementById('q-answered-count');
        const totalEl = document.getElementById('q-total-count');
        if (answeredEl) answeredEl.innerText = data.answered_count;
        if (totalEl) totalEl.innerText = data.total_players;
    }

    onQuestionResult(data) {
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }

        if (this.role === 'host') {
            this.renderHostResult(data);
        } else {
            this.renderPlayerResult(data);
        }
    }

    renderHostResult(data) {
        document.getElementById('host-result-qnum').innerText = `第 ${data.question_index} / ${data.total_questions} 題 結算`;
        
        // Find correct text
        let correctText = data.correct_answer;
        if (this.currentQuestionData && this.currentQuestionData.options) {
            const found = this.currentQuestionData.options.find(o => o.key === data.correct_answer);
            if (found) {
                correctText = `${data.correct_answer}. ${found.text}`;
            }
        }
        document.getElementById('host-correct-answer-text').innerText = correctText;

        // Render distribution bar chart
        const stats = data.stats || { A: 0, B: 0, C: 0, D: 0 };
        const maxVal = Math.max(1, stats.A, stats.B, stats.C, stats.D);

        ['A', 'B', 'C', 'D'].forEach(opt => {
            const count = stats[opt] || 0;
            const barVal = document.getElementById(`bar-val-${opt}`);
            const barFill = document.getElementById(`bar-fill-${opt}`);
            const col = document.getElementById(`col-${opt}`);

            if (barVal) barVal.innerText = `${count} 人`;
            const heightPct = Math.round((count / maxVal) * 85) + 5;
            if (barFill) barFill.style.height = `${heightPct}%`;

            // Highlight correct column
            if (col) {
                if (opt === data.correct_answer) {
                    col.style.transform = 'scale(1.05)';
                    barVal.style.color = '#4ade80';
                } else {
                    col.style.transform = 'scale(1)';
                    barVal.style.color = '#fff';
                }
            }
        });

        // Fastest player announcement
        const fastestBox = document.getElementById('fastest-announcement');
        const fastestName = document.getElementById('fastest-player-name');
        if (data.fastest_player) {
            fastestName.innerText = data.fastest_player;
            fastestBox.classList.remove('hidden');
        } else {
            fastestBox.classList.add('hidden');
        }

        // Leaderboard Top 5
        const lbList = document.getElementById('host-leaderboard-list');
        const top5 = (data.leaderboard || []).slice(0, 5);

        if (top5.length === 0) {
            lbList.innerHTML = '<div class="empty-hint">暫無排行榜資料</div>';
        } else {
            lbList.innerHTML = top5.map((p, idx) => {
                const rankClass = idx === 0 ? 'rank-1' : '';
                let badges = '';
                if (p.streak >= 2) {
                    badges += `<span class="badge-tag badge-streak">🔥 ${p.streak} 連勝</span>`;
                }
                if (p.rank_diff > 0) {
                    badges += `<span class="badge-tag badge-up">▲ 上升 ${p.rank_diff} 名</span>`;
                }
                if (data.fastest_player && p.nickname === data.fastest_player) {
                    badges += `<span class="badge-tag" style="background:#eab308;color:#000;">⚡ 最快</span>`;
                }

                return `
                    <div class="lb-row ${rankClass}">
                        <div class="lb-left">
                            <span class="lb-rank">#${p.rank}</span>
                            <span class="lb-name">${escapeHtml(p.nickname)}</span>
                            <div class="lb-badges">${badges}</div>
                        </div>
                        <span class="lb-score">${p.score} 分</span>
                    </div>
                `;
            }).join('');
        }

        // Next button text
        const nextBtn = document.getElementById('btn-host-next');
        if (data.is_last_question) {
            nextBtn.innerText = "查看最終頒獎台 🏆";
        } else {
            nextBtn.innerText = "下一題 ➜";
        }

        this.switchView('view-host-result');
    }

    renderPlayerResult(data) {
        const box = document.getElementById('player-result-box');
        const iconEl = document.getElementById('player-result-icon');
        const titleEl = document.getElementById('player-result-title');
        const scoreEl = document.getElementById('player-result-score');
        const rankEl = document.getElementById('player-res-rank');
        const totalEl = document.getElementById('player-res-total');
        const streakEl = document.getElementById('player-res-streak');
        const streakRow = document.getElementById('player-streak-row');
        const solutionRow = document.getElementById('player-correct-solution-row');
        const solutionEl = document.getElementById('player-res-solution');

        rankEl.innerText = `第 ${data.rank} 名 / ${data.total_players} 人`;
        totalEl.innerText = `${data.current_score} 分`;

        if (data.streak >= 2) {
            streakRow.classList.remove('hidden');
            streakEl.innerText = `🔥 ${data.streak} 連勝`;
        } else {
            streakRow.classList.add('hidden');
        }

        if (data.is_correct) {
            box.className = 'player-result-card correct';
            iconEl.innerText = '✓';
            titleEl.innerText = '答對了！太強了！';
            scoreEl.innerText = `+${data.points_earned} 分`;
            solutionRow.classList.add('hidden');
            if (window.soundEngine) window.soundEngine.playCorrect();
        } else {
            box.className = 'player-result-card wrong';
            iconEl.innerText = '✕';
            titleEl.innerText = '答錯了，再接再厲！';
            scoreEl.innerText = '+0 分';
            solutionRow.classList.remove('hidden');
            solutionEl.innerText = `選項 ${data.correct_answer}`;
            if (window.soundEngine) window.soundEngine.playWrong();
        }

        this.switchView('view-player-result');
    }

    onGameOver(data) {
        const podium = data.podium || [];
        const rankings = data.rankings || [];

        // 1st Place
        if (podium[0]) {
            document.getElementById('podium-name-1').innerText = podium[0].nickname;
            document.getElementById('podium-score-1').innerText = `${podium[0].score} 分`;
        }
        // 2nd Place
        if (podium[1]) {
            document.getElementById('podium-name-2').innerText = podium[1].nickname;
            document.getElementById('podium-score-2').innerText = `${podium[1].score} 分`;
        } else {
            document.getElementById('podium-name-2').innerText = '--';
            document.getElementById('podium-score-2').innerText = '--';
        }
        // 3rd Place
        if (podium[2]) {
            document.getElementById('podium-name-3').innerText = podium[2].nickname;
            document.getElementById('podium-score-3').innerText = `${podium[2].score} 分`;
        } else {
            document.getElementById('podium-name-3').innerText = '--';
            document.getElementById('podium-score-3').innerText = '--';
        }

        // Full rankings table
        const table = document.getElementById('final-rankings-table');
        if (rankings.length === 0) {
            table.innerHTML = '<div class="empty-hint">無參賽者資料</div>';
        } else {
            table.innerHTML = rankings.map(p => `
                <div class="lb-row">
                    <div class="lb-left">
                        <span class="lb-rank">#${p.rank}</span>
                        <span class="lb-name">${escapeHtml(p.nickname)}</span>
                    </div>
                    <span class="lb-score">${p.score} 分 (作答耗時 ${p.total_time}s)</span>
                </div>
            `).join('');
        }

        this.switchView('view-final');

        // Confetti and Victory Fanfare
        if (window.launchConfetti) {
            window.launchConfetti(5);
        }
        if (window.soundEngine) {
            window.soundEngine.playFanfare();
        }
    }

    onGameReset(data) {
        this.showToast("主持人重置了遊戲，回到大廳！");
        if (this.role === 'host') {
            this.switchView('view-host-lobby');
            this.onPlayerListUpdate(data);
        } else {
            this.switchView('view-player-lobby');
        }
    }
}

function jsonParse(str) {
    return JSON.parse(str);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, "&amp;")
              .replace(/</g, "&lt;")
              .replace(/>/g, "&gt;")
              .replace(/"/g, "&quot;")
              .replace(/'/g, "&#039;");
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new QuizApp();
});
