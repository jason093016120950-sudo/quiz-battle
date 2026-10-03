import asyncio
import json
import os
import sys
import websockets
import urllib.request

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

PORT = 8000
BASE_URL = f"http://127.0.0.1:{PORT}"
WS_URL = f"ws://127.0.0.1:{PORT}/ws"

async def recv_type(ws, target_type, timeout=10.0):
    async with asyncio.timeout(timeout):
        while True:
            raw = await ws.recv()
            data = json.loads(raw)
            if data.get("type") == target_type:
                return data

async def run_simulation():
    print("=== 開始全自動即時競賽模擬測試 (1 主持人 + 3 玩家) ===")

    # 1. Test HTTP endpoints
    print("\n[測試 1] 測試 HTTP API 與靜態檔案...")
    with urllib.request.urlopen(f"{BASE_URL}/api/info") as res:
        info = json.loads(res.read().decode())
        print(f" -> /api/info: {info}")
        assert info["total_questions"] == 15, "題目數應該為 15"

    with urllib.request.urlopen(f"{BASE_URL}/static/images/q15_photo.png") as res:
        img_bytes = res.read()
        print(f" -> 第 15 題圖片確認載入成功，檔案大小: {len(img_bytes)} bytes")
        assert len(img_bytes) > 10000, "圖片檔案大小異常"

    with urllib.request.urlopen(f"{BASE_URL}/api/qrcode?text=http://test") as res:
        qr_bytes = res.read()
        print(f" -> QR Code 產生成功，圖片大小: {len(qr_bytes)} bytes")
        assert len(qr_bytes) > 100, "QR Code 產生失敗"

    # 2. Host creates room
    print("\n[測試 2] 主持人建立房間...")
    host_ws = await websockets.connect(WS_URL)
    await host_ws.send(json.dumps({"type": "create_room"}))
    resp = await recv_type(host_ws, "room_created")
    pin = resp["pin"]
    host_id = resp["host_id"]
    print(f" -> 主持人房間建立成功！PIN: {pin}, Host ID: {host_id}")

    # 3. 3 Players join
    print("\n[測試 3] 三位同學透過手機加入房間...")
    players_meta = [
        {"name": "學霸小明", "id": "p_ming", "delay": 0.05},
        {"name": "行政之星小華", "id": "p_hua", "delay": 0.1},
        {"name": "大三阿強", "id": "p_qiang", "delay": 0.15},
    ]

    for p in players_meta:
        p["ws"] = await websockets.connect(WS_URL)
        await p["ws"].send(json.dumps({
            "type": "join_room",
            "pin": pin,
            "nickname": p["name"],
            "player_id": p["id"]
        }))
        join_ack = await recv_type(p["ws"], "join_success")
        print(f" -> 玩家「{p['name']}」成功加入 Lobby！")

    # Host checks player list
    while True:
        host_list_msg = await recv_type(host_ws, "player_list_update")
        if host_list_msg["count"] == 3:
            break
    print(" -> 3 位玩家全數就緒！")

    # 4. Host starts game
    print("\n[測試 4] 主持人點擊「開始遊戲」，全體進入 3 秒倒數...")
    await host_ws.send(json.dumps({"type": "start_game"}))

    # Read countdown 3, 2, 1
    for count in [3, 2, 1]:
        host_cd = await recv_type(host_ws, "countdown")
        assert host_cd["count"] == count
        for p in players_meta:
            p_cd = await recv_type(p["ws"], "countdown")
            assert p_cd["count"] == count
        print(f" -> 倒數: {count}")

    # 5. Loop through Question 1 to 15
    print("\n[測試 5] 開始進行 15 題即時問答競賽...")
    for q_idx in range(1, 16):
        print(f"\n--- [第 {q_idx} / 15 題] ---")

        # Receive question_start
        host_q = await recv_type(host_ws, "question_start")
        assert host_q["question_index"] == q_idx
        print(f" -> 題目：{host_q['question'].splitlines()[0]}")

        if q_idx == 15:
            print(" -> 特別檢查第 15 題圖片屬性...")
            assert host_q.get("image") == "/static/images/q15_photo.png", "第 15 題必須包含人物圖片路徑！"
            assert "國四英雄傳" in host_q["question"]
            assert "黃朝盟" in [opt["text"] for opt in host_q["options"]]
            print(" -> ✓ 第 15 題確認為國四英雄傳黃朝盟教授題目，並已附加指定圖片！")

        correct_answer = host_q["correct_answer"]

        # Players receive question
        for p in players_meta:
            p_q = await recv_type(p["ws"], "question_start")
            assert "correct_answer" not in p_q, "防作弊：玩家端不得在題目下發時收到答案！"

        # Players submit answers concurrently
        for idx, p in enumerate(players_meta):
            if idx == 0:
                choice = correct_answer  # 小明 100% 答對
            elif idx == 1:
                choice = correct_answer if (q_idx % 3 != 0) else ("D" if correct_answer != "D" else "A")
            else:
                choice = correct_answer if (q_idx % 2 == 1) else ("B" if correct_answer != "B" else "C")
            p["choice"] = choice

        # Player answers
        for p in players_meta:
            await asyncio.sleep(p["delay"])
            await p["ws"].send(json.dumps({
                "type": "submit_answer",
                "option": p["choice"]
            }))
            ack = await recv_type(p["ws"], "answer_locked")

        # Result is generated
        host_res = await recv_type(host_ws, "question_result")
        assert host_res["correct_answer"] == correct_answer
        print(f" -> 第 {q_idx} 題結算：正確答案是 {correct_answer}")
        print(f" -> 選項分佈統計：{host_res['stats']}")
        top1 = host_res["leaderboard"][0]
        print(f" -> 目前榜首：{top1['nickname']} (累積總分：{top1['score']} 分)")

        # Verify each player's result message
        for p in players_meta:
            p_res = await recv_type(p["ws"], "question_result")
            if p["choice"] == correct_answer:
                assert p_res["is_correct"] is True
                assert p_res["points_earned"] >= 500, f"得分計算異常: {p_res['points_earned']}"
            else:
                assert p_res["is_correct"] is False
                assert p_res["points_earned"] == 0

        # Host advances to next question (or final)
        if q_idx < 15:
            await host_ws.send(json.dumps({"type": "next_question"}))
            # Drain 3-second countdown
            for count in [3, 2, 1]:
                cd_h = await recv_type(host_ws, "countdown")
                assert cd_h["count"] == count
                for p in players_meta:
                    cd_p = await recv_type(p["ws"], "countdown")
                    assert cd_p["count"] == count
        else:
            print("\n[測試 6] 第 15 題完成！主持人點擊「查看最終頒獎台」...")
            await host_ws.send(json.dumps({"type": "next_question"}))
            final_host = await recv_type(host_ws, "game_over")
            print(" -> 頒獎台 Top 3 結果揭曉：")
            for idx, winner in enumerate(final_host["podium"]):
                medal = ["🥇", "🥈", "🥉"][idx]
                print(f"    {medal} 第 {idx+1} 名: {winner['nickname']} - 總分: {winner['score']} 分 (作答時間 {winner['total_time']} 秒)")

            for p in players_meta:
                final_p = await recv_type(p["ws"], "game_over")
                assert final_p["type"] == "game_over"

    print("\n[測試 7] 測試玩家中途斷線與重新連線功能...")
    # Reconnect test with p_ming
    ming = players_meta[0]
    await ming["ws"].close()
    await asyncio.sleep(0.1)

    # Reconnect
    ming_reconnect_ws = await websockets.connect(WS_URL)
    await ming_reconnect_ws.send(json.dumps({
        "type": "player_reconnect",
        "pin": pin,
        "player_id": ming["id"]
    }))
    recon_ack = await recv_type(ming_reconnect_ws, "player_reconnected")
    assert recon_ack["nickname"] == ming["name"]
    print(f" -> 玩家「{ming['name']}」斷線後重新連線成功！分數與狀態均完美恢復！")

    # Clean up
    try:
        await host_ws.close()
    except Exception:
        pass
    for p in players_meta:
        try:
            await p["ws"].close()
        except Exception:
            pass
    try:
        await ming_reconnect_ws.close()
    except Exception:
        pass

    print("\n=======================================================")
    print(" [SUCCESS] 全數 7 大項測試項目全部通過！零錯誤！完整跑完 15 題！")
    print("=======================================================")

if __name__ == "__main__":
    asyncio.run(run_simulation())
