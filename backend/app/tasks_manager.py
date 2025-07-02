# tasks_manager.py (в папке backend)
from typing import Dict
import asyncio

class PollingTasksManager:
    def __init__(self):
        self.tasks: Dict[str, asyncio.Task] = {}

    def start(self, task_id, coro):
        # coro - это объект-короутина, например poll_and_save()
        if task_id in self.tasks and not self.tasks[task_id].done():
            return False  # Уже запущена
        task = asyncio.create_task(coro)
        self.tasks[task_id] = task
        return True


    def stop(self, task_id):
        if task_id in self.tasks:
            self.tasks[task_id].cancel()
            return True
        return False

    def is_running(self, task_id):
        return task_id in self.tasks and not self.tasks[task_id].done()

tasks_manager = PollingTasksManager()
