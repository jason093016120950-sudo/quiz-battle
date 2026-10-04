import asyncio
import json
import logging
import os
import random
import re
import socket
import time
from typing import Dict, List, Optional, Any
from io import BytesIO
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException, Query
from fastapi.responses import HTMLResponse, FileResponse, Response
from fastapi.staticfiles import StaticFiles
import uvicorn
import qrcode

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("quiz-battle")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
QUESTIONS_FILE = os.path.join(BASE_DIR, "questions.json")

# Load questions
def load_questions() -> List[dict]:
    with open(QUESTIONS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

QUESTIONS = load_questions()
logger.info(f"Loaded {len(QUESTIONS)} questions from {QUESTIONS_FILE}")

def get_lan_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except Exception:
        return "127.0.0.1"

LAN_IP = get_lan_ip()
PUBLIC_URL: Optional[str] = os.getenv('PUBLIC_URL')
tunnel_process: Optional[asyncio.subprocess.Process] = None

class Player:
    def __init__(self, player_id: str, nickname: str, ws: Optional[WebSocket] = None):
        self.id = player_id
        self.nickname = nickname
        self.ws = ws
        self.score = 0
        self.total_time = 0.0  # seconds
        self.streak = 0
        self.connected = True
        self.answers: Dict[int, dict] = {}  # q_id -> {option, is_correct, time_spent, score}
        self.prev_rank = 0
        self.current_rank = 0

    def to_dict(self):
        return {
            "id": self.id,
            "nickname": self.nickname,
            "score": self.score,
            "total_time": round(self.total_time, 2),
            "streak": self.streak,
            "connected": self.connected,
            "current_rank": self.current_rank,
            "prev_rank": self.prev_rank
        }

class Room:
    def __init__(self, pin: str, host_id: str, host_ws: Optional[WebSocket] = None, room_id: Optional[str] = None):
        self.room_id = room_id or f"room_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
        self.pin = pin
        self.host_id = host_id
        self.host_ws = host_ws
        self.players: Dict[str, Player] = {}
        self.state: str = "LOBBY"  # LOBBY, COUNTDOWN, QUESTION, RESULT, FINAL, CLOSED
        self.current_q_idx: int = 0
        self.question_start_time: float = 0.0
        self.current_answers: Dict[str, dict] = {}  # player_id -> answer dict
        self.timer_task: Optional[asyncio.Task] = None
        self.countdown_task: Optional[asyncio.Task] = None
        self.created_at = time.time()
        self.is_closed: bool = False

    def get_connected_players(self) -> List[Player]:
        return [p for p in self.players.values() if p.connected]

    def get_leaderboard(self) -> List[dict]:
        sorted_players = sorted(
            self.players.values(),
            key=lambda p: (-p.score, p.total_time, p.nickname)
        )
        leaderboard = []
        for rank, p in enumerate(sorted_players, start=1):
            p.prev_rank = p.current_rank if p.current_rank > 0 else rank
            p.current_rank = rank
            rank_diff = p.prev_rank - p.current_rank
            leaderboard.append({
                "rank": rank,
                "id": p.id,
                "nickname": p.nickname,
                "score": p.score,
                "total_time": round(p.total_time, 2),
                "streak": p.streak,
                "rank_diff": rank_diff,
                "connected": p.connected
            })
        return leaderboard

    async def broadcast_host(self, data: dict):
        if self.host_ws:
            try:
                await self.host_ws.send_text(json.dumps(data))
            except Exception as e:
                logger.warning(f"Error sending to host in room {self.pin}: {e}")

    async def broadcast_player(self, player_id: str, data: dict):
        player = self.players.get(player_id)
        if player and player.ws:
            try:
                await player.ws.send_text(json.dumps(data))
            except Exception as e:
                logger.warning(f"Error sending to player {player.nickname}: {e}")

    async def broadcast_all_players(self, data: dict):
        tasks = []
        for p in self.players.values():
            if p.ws and p.connected:
                tasks.append(p.ws.send_text(json.dumps(data)))
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def broadcast_all(self, data: dict):
        await self.broadcast_host(data)
        await self.broadcast_all_players(data)

rooms: Dict[str, Room] = {}
closed_rooms: Dict[str, dict] = {}  # pin or room_id -> closed info

# ----------------- Tunnel Manager -----------------
async def start_tunnel():
    global PUBLIC_URL, tunnel_process
    cloudflared_exe = os.path.join(BASE_DIR, "cloudflared.exe")
    if not os.path.exists(cloudflared_exe):
        logger.info("cloudflared.exe not found. Public tunnel disabled.")
        return

    logger.info("Starting Cloudflare Quick Tunnel to allow students on 4G/5G/Campus Wi-Fi to scan & connect...")
    try:
        tunnel_process = await asyncio.create_subprocess_exec(
            cloudflared_exe, "tunnel", "--url", "http://127.0.0.1:8000",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )

        async def read_stream(stream):
            global PUBLIC_URL
            pattern = re.compile(r"https://[a-zA-Z0-9-]+\.trycloudflare\.com")
            while True:
                line = await stream.readline()
                if not line:
                    break
                decoded = line.decode("utf-8", errors="ignore")
                match = pattern.search(decoded)
                if match and not PUBLIC_URL:
                    PUBLIC_URL = match.group(0)
                    logger.info(f"===> Cloudflare Tunnel active! Public URL: {PUBLIC_URL}")
                    for r in rooms.values():
                        if r.state == "LOBBY":
                            await r.broadcast_host({
                                "type": "public_url_ready",
                                "public_url": PUBLIC_URL
                            })

        asyncio.create_task(read_stream(tunnel_process.stdout))
        asyncio.create_task(read_stream(tunnel_process.stderr))
    except Exception as e:
        logger.warning(f"Failed to start cloudflared tunnel: {e}")

@asynccontextmanager
async def lifespan(app: FastAPI):
    asyncio.create_task(start_tunnel())
    yield
    if tunnel_process:
        try:
            tunnel_process.terminate()
        except Exception:
            pass

app = FastAPI(title="Quiz Battle Server", lifespan=lifespan)

# Serve static files
static_dir = os.path.join(BASE_DIR, "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

@app.api_route("/", methods=["GET", "HEAD"])
async def get_index():
    index_path = os.path.join(static_dir, "index.html")
    if os.path.exists(index_path):
        return FileResponse(index_path)
    return HTMLResponse("<h1>Quiz Battle Server is starting...</h1>")

@app.get("/api/info")
async def get_info():
    return {
        "lan_ip": LAN_IP,
        "public_url": PUBLIC_URL,
        "total_questions": len(QUESTIONS),
        "active_rooms": len(rooms)
    }

@app.get("/api/qrcode")
async def get_qrcode(text: str = Query(..., description="URL to encode in QR code")):
    qr = qrcode.QRCode(
        version=1,
        error_correction=qrcode.constants.ERROR_CORRECT_M,
        box_size=8,
        border=2,
    )
    qr.add_data(text)
    qr.make(fit=True)
    img = qr.make_image(fill_color="#200840", back_color="#FFFFFF")
    buf = BytesIO()
    img.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")

@app.get("/api/questions")
async def get_questions_api():
    sanitized = []
    for q in QUESTIONS:
        sanitized.append({
            "id": q["id"],
            "question": q["question"],
            "options": q["options"],
            "timeLimit": q["timeLimit"],
            "image": q.get("image")
        })
    return sanitized

# ----------------- Game Control Logic -----------------

async def run_countdown(room: Room, next_action: str = "question"):
    room.state = "COUNTDOWN"
    for count in range(3, 0, -1):
        if room.is_closed:
            return
        await room.broadcast_all({
            "type": "countdown",
            "count": count,
            "question_index": room.current_q_idx + 1,
            "total_questions": len(QUESTIONS)
        })
        await asyncio.sleep(1.0)
    
    if next_action == "question" and not room.is_closed:
        await start_question(room)

async def start_question(room: Room):
    if room.is_closed:
        return
    if room.current_q_idx >= len(QUESTIONS):
        await end_game(room)
        return

    room.state = "QUESTION"
    room.current_answers.clear()
    q = QUESTIONS[room.current_q_idx]
    room.question_start_time = time.time()
    time_limit = q.get("timeLimit", 20)

    if room.timer_task and not room.timer_task.done():
        room.timer_task.cancel()

    q_data_host = {
        "type": "question_start",
        "question_index": room.current_q_idx + 1,
        "total_questions": len(QUESTIONS),
        "question_id": q["id"],
        "question": q["question"],
        "options": q["options"],
        "time_limit": time_limit,
        "image": q.get("image"),
        "answered_count": 0,
        "total_players": len(room.get_connected_players()),
        "correct_answer": q["correctAnswer"]
    }

    q_data_player = {
        "type": "question_start",
        "question_index": room.current_q_idx + 1,
        "total_questions": len(QUESTIONS),
        "question_id": q["id"],
        "question": q["question"],
        "options": q["options"],
        "time_limit": time_limit,
        "image": q.get("image"),
        "answered_count": 0,
        "total_players": len(room.get_connected_players())
    }

    await room.broadcast_host(q_data_host)
    await room.broadcast_all_players(q_data_player)

    room.timer_task = asyncio.create_task(question_timer(room, time_limit))

async def question_timer(room: Room, seconds: int):
    try:
        await asyncio.sleep(seconds)
        if room.state == "QUESTION" and not room.is_closed:
            await finish_question(room, reason="timeout")
    except asyncio.CancelledError:
        pass

async def finish_question(room: Room, reason: str = "all_answered"):
    if room.timer_task and not room.timer_task.done():
        room.timer_task.cancel()

    if room.is_closed:
        return

    room.state = "RESULT"
    q = QUESTIONS[room.current_q_idx]
    correct_opt = q["correctAnswer"]

    stats = {"A": 0, "B": 0, "C": 0, "D": 0}
    fastest_time = 999.0
    fastest_player_name = ""

    for p in room.players.values():
        ans_info = room.current_answers.get(p.id)
        if ans_info:
            opt = ans_info["option"]
            stats[opt] = stats.get(opt, 0) + 1
            if ans_info["is_correct"]:
                if ans_info["time_spent"] < fastest_time:
                    fastest_time = ans_info["time_spent"]
                    fastest_player_name = p.nickname
        else:
            p.streak = 0
            p.answers[q["id"]] = {
                "option": None,
                "is_correct": False,
                "time_spent": 20.0,
                "score": 0
            }

    leaderboard = room.get_leaderboard()
    is_last = (room.current_q_idx == len(QUESTIONS) - 1)

    host_payload = {
        "type": "question_result",
        "question_index": room.current_q_idx + 1,
        "total_questions": len(QUESTIONS),
        "correct_answer": correct_opt,
        "stats": stats,
        "leaderboard": leaderboard,
        "fastest_player": fastest_player_name if fastest_time < 999 else None,
        "answered_count": len(room.current_answers),
        "total_players": len(room.get_connected_players()),
        "is_last_question": is_last,
        "reason": reason
    }
    await room.broadcast_host(host_payload)

    for p in room.players.values():
        ans_info = room.current_answers.get(p.id)
        player_rank = next((item["rank"] for item in leaderboard if item["id"] == p.id), 1)
        if ans_info:
            p_payload = {
                "type": "question_result",
                "question_index": room.current_q_idx + 1,
                "total_questions": len(QUESTIONS),
                "is_correct": ans_info["is_correct"],
                "your_answer": ans_info["option"],
                "correct_answer": correct_opt,
                "points_earned": ans_info["score"],
                "current_score": p.score,
                "streak": p.streak,
                "rank": player_rank,
                "total_players": len(room.players),
                "is_last_question": is_last
            }
        else:
            p_payload = {
                "type": "question_result",
                "question_index": room.current_q_idx + 1,
                "total_questions": len(QUESTIONS),
                "is_correct": False,
                "your_answer": None,
                "correct_answer": correct_opt,
                "points_earned": 0,
                "current_score": p.score,
                "streak": 0,
                "rank": player_rank,
                "total_players": len(room.players),
                "is_last_question": is_last
            }
        await room.broadcast_player(p.id, p_payload)

async def end_game(room: Room):
    if room.is_closed:
        return
    room.state = "FINAL"
    leaderboard = room.get_leaderboard()
    podium = leaderboard[:3]

    final_payload = {
        "type": "game_over",
        "podium": podium,
        "rankings": leaderboard,
        "total_questions": len(QUESTIONS)
    }
    await room.broadcast_all(final_payload)

# ----------------- WebSocket Handler -----------------

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    await ws.accept()
    client_role: Optional[str] = None
    client_pin: Optional[str] = None
    client_player_id: Optional[str] = None

    try:
        while True:
            raw_data = await ws.receive_text()
            try:
                data = json.loads(raw_data)
            except json.JSONDecodeError:
                continue

            msg_type = data.get("type")

            # 1. Host creates room
            if msg_type == "create_room":
                pin = str(random.randint(100000, 999999))
                while pin in rooms or pin in closed_rooms:
                    pin = str(random.randint(100000, 999999))

                host_id = f"host_{int(time.time() * 1000)}"
                room_id = f"room_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
                room = Room(pin, host_id, ws, room_id=room_id)
                rooms[pin] = room
                client_role = "host"
                client_pin = pin

                await ws.send_text(json.dumps({
                    "type": "room_created",
                    "pin": pin,
                    "room_id": room_id,
                    "host_id": host_id,
                    "lan_ip": LAN_IP,
                    "public_url": PUBLIC_URL,
                    "total_questions": len(QUESTIONS),
                    "is_new_session": True
                }))
                logger.info(f"Room {pin} ({room_id}) created by host {host_id}")

            # 2. Host reconnects
            elif msg_type == "host_reconnect":
                pin = data.get("pin")
                host_id = data.get("host_id")
                room = rooms.get(pin)
                if room and room.host_id == host_id and not room.is_closed:
                    room.host_ws = ws
                    client_role = "host"
                    client_pin = pin
                    q = QUESTIONS[room.current_q_idx] if room.current_q_idx < len(QUESTIONS) else None
                    await ws.send_text(json.dumps({
                        "type": "host_reconnected",
                        "pin": pin,
                        "room_id": room.room_id,
                        "state": room.state,
                        "current_q_idx": room.current_q_idx,
                        "players": [p.to_dict() for p in room.players.values()],
                        "leaderboard": room.get_leaderboard() if room.state in ["RESULT", "FINAL"] else [],
                        "total_questions": len(QUESTIONS),
                        "public_url": PUBLIC_URL,
                        "lan_ip": LAN_IP,
                        "question": q if (room.state == "QUESTION" and q) else None
                    }))
                else:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "找不到主持人房間或驗證失敗"
                    }))

            # 3. Player joins room
            elif msg_type == "join_room":
                pin = data.get("pin", "").strip()
                req_room_id = data.get("room_id", "").strip()
                nickname = data.get("nickname", "").strip()
                player_id = data.get("player_id", "").strip()

                if not pin or not nickname:
                    await ws.send_text(json.dumps({
                        "type": "join_error",
                        "message": "請輸入遊戲 PIN 與暱稱"
                    }))
                    continue

                # Check if this room or pin was already closed!
                if pin in closed_rooms or (req_room_id and req_room_id in closed_rooms):
                    await ws.send_text(json.dumps({
                        "type": "room_closed",
                        "message": "此遊戲已經結束，請掃描主持人最新的 QR Code 或輸入新的 PIN 碼"
                    }))
                    continue

                room = rooms.get(pin)
                if not room or room.is_closed:
                    await ws.send_text(json.dumps({
                        "type": "room_closed" if pin in closed_rooms else "join_error",
                        "message": "此遊戲已經結束，請輸入最新的 PIN 碼" if pin in closed_rooms else f"找不到 Game PIN：{pin}，請確認後重新輸入"
                    }))
                    continue

                # If QR code passed room_id, enforce room_id match
                if req_room_id and room.room_id != req_room_id:
                    await ws.send_text(json.dumps({
                        "type": "room_closed",
                        "message": "此遊戲已非最新場次，請掃描大螢幕最新 QR Code"
                    }))
                    continue

                if room.state != "LOBBY":
                    existing = room.players.get(player_id)
                    if not existing:
                        await ws.send_text(json.dumps({
                            "type": "join_error",
                            "message": "遊戲已經開始，無法新加入玩家"
                        }))
                        continue

                for pid, p in room.players.items():
                    if pid != player_id and p.nickname.lower() == nickname.lower() and p.connected:
                        await ws.send_text(json.dumps({
                            "type": "join_error",
                            "message": f"暱稱「{nickname}」已被使用，請換一個暱稱"
                        }))
                        break
                else:
                    if not player_id:
                        player_id = f"p_{int(time.time() * 1000)}_{random.randint(100, 999)}"

                    if player_id in room.players:
                        player = room.players[player_id]
                        player.nickname = nickname
                        player.ws = ws
                        player.connected = True
                    else:
                        player = Player(player_id, nickname, ws)
                        room.players[player_id] = player

                    client_role = "player"
                    client_pin = pin
                    client_player_id = player_id

                    await ws.send_text(json.dumps({
                        "type": "join_success",
                        "pin": pin,
                        "room_id": room.room_id,
                        "player_id": player_id,
                        "nickname": nickname,
                        "state": room.state
                    }))

                    player_list = [p.to_dict() for p in room.players.values()]
                    # Only the host needs the full lobby list. Avoid O(n^2) fan-out to all players.
                    await room.broadcast_host({
                        "type": "player_list_update",
                        "players": player_list,
                        "count": len(room.get_connected_players())
                    })
                    logger.info(f"Player {nickname} ({player_id}) joined room {pin} ({room.room_id})")

            # 4. Player reconnects
            elif msg_type == "player_reconnect":
                pin = data.get("pin")
                req_room_id = data.get("room_id")
                player_id = data.get("player_id")

                if pin in closed_rooms or (req_room_id and req_room_id in closed_rooms):
                    await ws.send_text(json.dumps({
                        "type": "room_closed",
                        "message": "此遊戲已經結束"
                    }))
                    continue

                room = rooms.get(pin)
                if room and not room.is_closed and (not req_room_id or room.room_id == req_room_id) and player_id in room.players:
                    player = room.players[player_id]
                    player.ws = ws
                    player.connected = True
                    client_role = "player"
                    client_pin = pin
                    client_player_id = player_id

                    has_answered = (player_id in room.current_answers)
                    q = QUESTIONS[room.current_q_idx] if room.current_q_idx < len(QUESTIONS) else None

                    await ws.send_text(json.dumps({
                        "type": "player_reconnected",
                        "pin": pin,
                        "room_id": room.room_id,
                        "player_id": player_id,
                        "nickname": player.nickname,
                        "score": player.score,
                        "streak": player.streak,
                        "state": room.state,
                        "current_q_idx": room.current_q_idx + 1,
                        "total_questions": len(QUESTIONS),
                        "has_answered": has_answered,
                        "selected_option": room.current_answers.get(player_id, {}).get("option") if has_answered else None,
                        "question": {
                            "question_index": room.current_q_idx + 1,
                            "total_questions": len(QUESTIONS),
                            "question_id": q["id"],
                            "question": q["question"],
                            "options": q["options"],
                            "time_limit": q.get("timeLimit", 20),
                            "image": q.get("image")
                        } if (room.state == "QUESTION" and q) else None
                    }))
                    await room.broadcast_host({
                        "type": "player_status_change",
                        "player_id": player_id,
                        "connected": True,
                        "connected_count": len(room.get_connected_players())
                    })
                else:
                    await ws.send_text(json.dumps({
                        "type": "reconnect_failed",
                        "message": "連線過期或房間不存在"
                    }))

            # 5. Host starts game
            elif msg_type == "start_game":
                if client_role != "host" or not client_pin:
                    continue
                room = rooms.get(client_pin)
                if not room or room.is_closed:
                    continue
                if len(room.players) == 0:
                    await ws.send_text(json.dumps({
                        "type": "error",
                        "message": "目前還沒有玩家加入，請等待至少一位玩家加入後再開始"
                    }))
                    continue
                
                room.current_q_idx = 0
                asyncio.create_task(run_countdown(room, "question"))

            # 6. Player submits answer
            elif msg_type == "submit_answer":
                if client_role != "player" or not client_pin or not client_player_id:
                    continue
                room = rooms.get(client_pin)
                if not room or room.state != "QUESTION" or room.is_closed:
                    continue

                option = data.get("option")
                q = QUESTIONS[room.current_q_idx]

                if client_player_id in room.current_answers:
                    continue

                answer_time = time.time()
                time_spent = min(20.0, max(0.05, answer_time - room.question_start_time))
                remaining_time = max(0.0, 20.0 - time_spent)

                is_correct = (option == q["correctAnswer"])
                player = room.players.get(client_player_id)
                if not player:
                    continue

                if is_correct:
                    score = int(round(500 + 500 * (remaining_time / 20.0)))
                    player.streak += 1
                else:
                    score = 0
                    player.streak = 0

                player.score += score
                player.total_time += time_spent

                ans_record = {
                    "option": option,
                    "is_correct": is_correct,
                    "time_spent": time_spent,
                    "score": score
                }
                player.answers[q["id"]] = ans_record
                room.current_answers[client_player_id] = ans_record

                await ws.send_text(json.dumps({
                    "type": "answer_locked",
                    "option": option
                }))

                answered_count = len(room.current_answers)
                connected_players = room.get_connected_players()
                total_players = len(connected_players)

                await room.broadcast_host({
                    "type": "answer_update",
                    "answered_count": answered_count,
                    "total_players": total_players
                })

                if total_players > 0 and answered_count >= total_players:
                    asyncio.create_task(finish_question(room, reason="all_answered"))

            # 7. Host ends question early
            elif msg_type == "end_question_early":
                if client_role != "host" or not client_pin:
                    continue
                room = rooms.get(client_pin)
                if room and room.state == "QUESTION" and not room.is_closed:
                    asyncio.create_task(finish_question(room, reason="host_skip"))

            # 8. Host next question
            elif msg_type == "next_question":
                if client_role != "host" or not client_pin:
                    continue
                room = rooms.get(client_pin)
                if not room or room.state != "RESULT" or room.is_closed:
                    continue

                room.current_q_idx += 1
                if room.current_q_idx >= len(QUESTIONS):
                    asyncio.create_task(end_game(room))
                else:
                    asyncio.create_task(run_countdown(room, "question"))

            # 9. Host play again -> CREATES A TRULY NEW SESSION!
            elif msg_type == "play_again":
                if client_role != "host" or not client_pin:
                    continue
                old_room = rooms.get(client_pin)
                old_pin = client_pin
                host_id = None

                if old_room:
                    host_id = old_room.host_id
                    # Close the previous session & notify old players
                    old_room.is_closed = True
                    old_room.state = "CLOSED"
                    closed_rooms[old_room.pin] = {"room_id": old_room.room_id, "closed_at": time.time()}
                    closed_rooms[old_room.room_id] = {"pin": old_room.pin, "closed_at": time.time()}

                    await old_room.broadcast_all_players({
                        "type": "room_closed",
                        "message": "上一場遊戲已正式結束，主持人已開啟新一輪競賽！請掃描大螢幕的新 QR Code 加入！"
                    })
                    if old_pin in rooms:
                        del rooms[old_pin]

                if not host_id:
                    host_id = f"host_{int(time.time() * 1000)}"

                # Generate NEW distinct PIN and room_id
                new_pin = str(random.randint(100000, 999999))
                while new_pin == old_pin or new_pin in rooms or new_pin in closed_rooms:
                    new_pin = str(random.randint(100000, 999999))

                new_room_id = f"room_{int(time.time() * 1000)}_{random.randint(1000, 9999)}"
                new_room = Room(new_pin, host_id, ws, room_id=new_room_id)
                rooms[new_pin] = new_room
                client_pin = new_pin

                # Send new room created to Host
                await ws.send_text(json.dumps({
                    "type": "room_created",
                    "pin": new_pin,
                    "room_id": new_room_id,
                    "host_id": host_id,
                    "lan_ip": LAN_IP,
                    "public_url": PUBLIC_URL,
                    "total_questions": len(QUESTIONS),
                    "is_new_session": True
                }))
                logger.info(f"Host started NEW session: Room {new_pin} ({new_room_id})")

            # 10. Host ends game session explicitly
            elif msg_type == "end_game_session":
                if client_role != "host" or not client_pin:
                    continue
                room = rooms.get(client_pin)
                if room:
                    room.is_closed = True
                    room.state = "CLOSED"
                    closed_rooms[room.pin] = {"room_id": room.room_id, "closed_at": time.time()}
                    closed_rooms[room.room_id] = {"pin": room.pin, "closed_at": time.time()}

                    await room.broadcast_all_players({
                        "type": "room_closed",
                        "message": "主持人已結束本次遊戲房間"
                    })
                    if client_pin in rooms:
                        del rooms[client_pin]

                await ws.send_text(json.dumps({
                    "type": "session_terminated",
                    "message": "遊戲房間已結束"
                }))
                client_pin = None

            # 11. Ping keep-alive
            elif msg_type == "ping":
                await ws.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        logger.info(f"WebSocket disconnected: role={client_role}, pin={client_pin}")
        if client_pin and client_pin in rooms:
            room = rooms[client_pin]
            if client_role == "player" and client_player_id in room.players:
                player = room.players[client_player_id]
                player.connected = False
                await room.broadcast_host({
                    "type": "player_status_change",
                    "player_id": client_player_id,
                    "connected": False,
                    "connected_count": len(room.get_connected_players())
                })
                if room.state == "QUESTION":
                    connected = room.get_connected_players()
                    if len(connected) > 0 and len(room.current_answers) >= len(connected):
                        asyncio.create_task(finish_question(room, reason="all_answered"))
            elif client_role == "host":
                # Host disconnect ends the session by design: no host progress is persisted.
                room.host_ws = None
                room.is_closed = True
                room.state = "CLOSED"
                closed_rooms[room.pin] = {"room_id": room.room_id, "closed_at": time.time()}
                closed_rooms[room.room_id] = {"pin": room.pin, "closed_at": time.time()}
                await room.broadcast_all_players({
                    "type": "room_closed",
                    "message": "主持人已離開，本局已結束。請等待主持人重新建立新遊戲。"
                })
                if client_pin in rooms:
                    del rooms[client_pin]
    except Exception as e:
        logger.error(f"Unexpected error in websocket: {e}")

if __name__ == "__main__":
    uvicorn.run("server:app", host="0.0.0.0", port=8000, reload=False)
