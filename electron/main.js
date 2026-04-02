import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { exec } from 'child_process';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function createWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  });

  // In development, load the Vite dev server
  // In production, you would load the built index.html
  win.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:3000');
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Handle system commands from the React app
ipcMain.handle('run-system-command', async (event, command) => {
  return new Promise((resolve) => {
    exec(command, (error, stdout, stderr) => {
      if (error) {
        resolve({ success: false, output: error.message });
      } else {
        resolve({ success: true, output: stdout || stderr });
      }
    });
  });
});
