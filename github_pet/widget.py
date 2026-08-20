import os
import tkinter as tk
import webbrowser
from .models import MonitorSnapshot


STATE_TEXT = {"HAPPY": ("😊", "Todo tranquilo"), "ALERT": ("🔔", "Tienes reviews pendientes"),
              "RE_REVIEW": ("🔄", "Hay PRs para re-revisar"), "ACTION_REQUIRED": ("⚡", "Acción requerida en tus PRs")}


class PetWidget:
    def __init__(self, refresh_callback, interval_ms: int = 180_000):
        self.refresh_callback, self.interval_ms = refresh_callback, interval_ms
        self.root = tk.Tk()
        self.root.title("GitHub Pet")
        self.root.overrideredirect(True)
        self.root.attributes("-topmost", True)
        self.root.attributes("-alpha", 0.96)
        self.root.configure(bg="#182235")
        self.root.geometry("300x190+25+25")
        self.root.bind("<ButtonPress-1>", self._start_drag)
        self.root.bind("<B1-Motion>", self._drag)
        self.face = tk.Label(self.root, text="😊", font=("Segoe UI Emoji", 48), bg="#182235", fg="white")
        self.face.pack(pady=(8, 0))
        self.message = tk.Label(self.root, text="Conectando...", font=("Segoe UI", 11, "bold"), bg="#182235", fg="white", wraplength=270)
        self.message.pack()
        self.list_frame = tk.Frame(self.root, bg="#182235")
        self.list_frame.pack(fill="both", expand=True, padx=8)
        tk.Button(self.root, text="Actualizar", command=self.refresh_callback, bg="#2d405f", fg="white", relief="flat").pack(side="left", padx=8, pady=6)
        tk.Button(self.root, text="×", command=self.root.destroy, bg="#7f3340", fg="white", relief="flat").pack(side="right", padx=8, pady=6)
        self._drag_origin = (0, 0)

    def _start_drag(self, event): self._drag_origin = (event.x_root - self.root.winfo_x(), event.y_root - self.root.winfo_y())
    def _drag(self, event): self.root.geometry(f"+{event.x_root-self._drag_origin[0]}+{event.y_root-self._drag_origin[1]}")

    def show(self, snapshot: MonitorSnapshot):
        emoji, text = STATE_TEXT[snapshot.state]
        self.face.config(text=emoji)
        self.message.config(text=text if not snapshot.alerts else f"{text} ({len(snapshot.alerts)})")
        for child in self.list_frame.winfo_children(): child.destroy()
        for alert in snapshot.alerts[:5]:
            link = tk.Label(self.list_frame, text=f"• {alert.label}: #{alert.pr.number} {alert.pr.title[:32]}", anchor="w", cursor="hand2", bg="#182235", fg="#80c7ff", wraplength=275, justify="left")
            link.pack(fill="x")
            link.bind("<Button-1>", lambda _e, url=alert.pr.url: webbrowser.open(url))

    def _poll(self):
        self.refresh_callback()
        self.root.after(self.interval_ms, self._poll)

    def run(self):
        self.root.after(self.interval_ms, self._poll)
        self.root.mainloop()
