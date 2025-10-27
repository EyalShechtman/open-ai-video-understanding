# Video Understanding App

Analyze videos with AI - upload a video and get frame-by-frame descriptions powered by Google Gemini.

## Quick Start

1. **Set up environment**:
```bash
echo "GOOGLE_API_KEY=your_api_key" > backend/.env
```

2. **Run backend** (Terminal 1):
```bash
cd backend && cargo run
```

3. **Run frontend** (Terminal 2):
```bash
cd frontend && npm install && npm run dev
```

4. Open `http://localhost:3000` in your browser and upload a video.

