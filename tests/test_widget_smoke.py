import unittest
import tkinter as tk

class WidgetSmokeTests(unittest.TestCase):
    def test_tk_available_on_windows(self):
        root = tk.Tk(); root.withdraw(); root.overrideredirect(True); root.attributes("-topmost", True); root.destroy()

if __name__ == "__main__": unittest.main()

