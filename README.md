# AI OP/ED Merger

Collect song lyrics, align them against an episode, and export merged ASS subtitles. The app reads downloaded MKVs in your browser.

The release lives under `docs/`. Serve that folder over HTTP for local development, for example with `python -m http.server 8000 --directory docs`.

## Using the app

1. Choose a downloaded MKV and select its full subtitle track.
2. Choose Opening or Ending. The app uses the matching MKV chapter start when available. Enter a start if the chapter is missing. The draft ends 1:30 later, or earlier if the chapter or episode ends sooner. You can enter a different end time.
3. Search LRCLIB and import the matching recording, or use the Uta-Net and UtaTen links and paste lyrics with their source URL. For shows in the theme catalog, the app fills the opening and ending titles separately.
4. For a timed recording, build a draft to place the source timestamps relative to the episode start. To adjust the timing, choose the first line heard and match it to the playhead. You can also trim the line range or match a later line to correct steady drift. Listen through the draft before exporting.
5. For plain lyrics, build a draft with blank timings and mark each line as you listen. You can edit individual start and end times in either mode.
6. Download the merged ASS, or export a project ZIP with the original and merged subtitles, the fonts, and a JSON record of the lyrics and timing choices.

To continue editing later, choose the same MKV and open the project ZIP under **Export**.

Chapters locate the song within the episode. LRCLIB timestamps describe a specific recording. They can differ from a TV cut, so trim the source line range and check each cue. If the recording skips or repeats material within that range, use line-by-line timing across the edit.

Preview depends on browser support for the episode's video and audio codecs. If the MKV cannot play, use a same-length preview file with the same time origin, or enter timestamps from your player. This release supports embedded ASS tracks and leaves the episode file untouched.

LRCLIB searches send the typed query to LRCLIB. Selected episodes, fonts, and projects are processed in memory and exported to your computer. Save a project ZIP before closing the page.

[Matroska subtitle parser](https://github.com/mathiasvr/matroska-subtitles) · [LRCLIB API](https://lrclib.net/docs.txt)
