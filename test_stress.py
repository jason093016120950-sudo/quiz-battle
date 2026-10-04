import asyncio, json, random, sys, time
import websockets

HOST = 'localhost'
PORT = 8000
WS_URL = f'ws://{HOST}:{PORT}/ws'
TOTAL_PLAYERS = 70
QUESTIONS_TO_RUN = 5

async def host_flow():
    await asyncio.sleep(3)  # wait for server startup
        await ws.send(json.dumps({"type": "create_room"}))
        data = json.loads(await ws.recv())
        if data.get('type') != 'room_created':
            print('Host fail', data)
            return None
        pin = data['pin']
        room_id = data['room_id']
        # start game after a short wait
        async def start_game():
            await ws.send(json.dumps({"type": "start_game", "pin": pin}))
        asyncio.create_task(start_game())
        return pin, room_id

async def player_flow(pin, player_id):
    async with websockets.connect(WS_URL) as ws:
        nickname = f'P{player_id}'
        await ws.send(json.dumps({"type": "join_room", "pin": pin, "nickname": nickname, "player_id": f'p{player_id}'}))
        while True:
            try:
                msg = json.loads(await ws.recv())
            except websockets.exceptions.ConnectionClosed:
                break
            if msg.get('type') == 'question_start':
                # submit random answer
                option = random.choice(['A','B','C','D'])
                await ws.send(json.dumps({"type": "submit_answer", "option": option}))
            elif msg.get('type') == 'game_over':
                break

async def main():
    host = await host_flow()
    if not host:
        sys.exit(1)
    pin, _ = host
    players = [asyncio.create_task(player_flow(pin, i)) for i in range(TOTAL_PLAYERS)]
    await asyncio.gather(*players)
    print('Stress test completed')

if __name__ == '__main__':
    asyncio.run(main())
