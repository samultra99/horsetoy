from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.state.jobs import subscribe, unsubscribe

router = APIRouter()


@router.websocket("/ws/progress")
async def ws_progress(websocket: WebSocket) -> None:
    await websocket.accept()
    queue = subscribe()
    try:
        while True:
            event = await queue.get()
            await websocket.send_json(
                {
                    "job_id": event.job_id,
                    "stage": event.stage,
                    "percent": event.percent,
                    "message": event.message,
                }
            )
    except WebSocketDisconnect:
        pass
    finally:
        unsubscribe(queue)
