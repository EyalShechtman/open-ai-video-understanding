# How to Manually Upload Data to Pinecone

Your Pinecone index `democrash-mp4` exists but has no data. Follow these steps to populate it.

## Step 1: Get your frame data

You need the JSON output from processing your video. This should look like:

```json
{
  "status": "ok",
  "summary": "Brief description of the video",
  "records": [
    {
      "frame_id": 0,
      "timestamp": 0.0,
      "description": "Description of what's in the frame",
      "path": "backend/data/frame_000.png"
    },
    {
      "frame_id": 1,
      "timestamp": 0.5,
      "description": "Description of what's in the frame",
      "path": "backend/data/frame_001.png"
    }
  ]
}
```

### Option A: If you already processed the video
Check your backend console logs or network responses for the JSON output.

### Option B: Process the video again
1. Start your Rust backend: `cd backend && cargo run`
2. Upload your video through the frontend
3. Copy the JSON response

### Option C: Use test data (for testing)
Use the sample data in `/tmp/test_migrate_data.json`

## Step 2: Use the migration page

1. Navigate to `http://localhost:3000/migrate`
2. The form should be pre-filled with:
   - Video file: `democrash-mp4`
   - Index name override: `democrash-mp4`
   - Skip index creation: **CHECKED** ✓
   - Video ID: `1`

3. Paste your JSON data into the large text area

4. Click "Index Records"

5. Check the browser console (F12 → Console tab) for detailed logs:
   - You should see: `[ingest_final] indexName="democrash-mp4", skipEnsure=true`
   - You should see: `[ingest_final] Skipping ensureIndexReady for "democrash-mp4"`
   - Response should show: `status: "ok"` with upserted count

## Step 3: Verify in Pinecone

1. Go to your Pinecone dashboard
2. Click on the `democrash-mp4` index
3. You should see records appearing in the "RECORD COUNT"

## Troubleshooting

### Error: "model.embedContents is not a function"

**FIXED!** This was a bug in the API code. The fix has been applied - the code now uses `embedContent` (singular) correctly.

### Error: "Timed out waiting for Pinecone index..."

This means `skipEnsure` is NOT being set to true. Check:
1. Make sure the checkbox is checked
2. Check browser console to verify `skipEnsure=true` in the logs
3. Make sure you're on the latest code (refresh the page)

### Error: "No records found in JSON"

Your JSON is missing the `records` array or it's empty. Make sure:
1. The JSON has a `records` field
2. The `records` field is an array with at least one item

### Error: 500 Internal Server Error

Check:
1. Environment variables are set (PINECONE_API_KEY, GOOGLE_API_KEY)
2. The index name matches exactly (case-sensitive)
3. Browser console for the actual error message
4. Network tab → Response to see the full error

### Still having issues?

The code now has extensive logging. Open browser console (F12) and:
1. Look for lines starting with `[ingest_final]`
2. Check the "Sending payload to /api/RAG:" log
3. Check the "Response data:" log
4. Share these logs for debugging

