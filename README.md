# AI OP/ED Merger

Collect song lyrics, align them against an episode, and export merged ASS subtitles. The app reads downloaded MKVs in your browser.

The release lives under `docs/`. Serve that folder over HTTP for local development, for example with `python -m http.server 8000 --directory docs`.

## Using the app

1. Choose a downloaded MKV and select its full subtitle track.
2. Choose Opening or Ending. The app uses the matching MKV chapter start when available. Enter a start if the chapter is missing. The draft ends 1:34 later, or earlier if the chapter or episode ends sooner. You can enter a different end time.
3. Search LRCLIB and import the matching recording, or use the Uta-Net and UtaTen links and paste lyrics with their source URL. The app uses the theme catalog to look up songs by title and artist. For other anime, it uses AniList to find English, Japanese, and romanized titles when it can identify the show.
4. For a timed recording, build a draft to place the source timestamps relative to the episode start. To adjust the timing, choose the first line heard and match it to the playhead. You can also trim the line range or match a later line to correct steady drift. Listen through the draft before exporting.
5. For plain lyrics, build a draft with blank timings and mark each line as you listen. You can edit individual start and end times in either mode.
6. Download the merged ASS, or export a project ZIP with the original and merged subtitles, the fonts, and a JSON record of the lyrics and timing choices.

To continue editing later, choose the same MKV and open the project ZIP under **Export**.

Chapters locate the song within the episode. LRCLIB timestamps describe a specific recording. If the timing jumps at a TV edit, select the first line after the edit as the second anchor, choose **Shift from this line**, and enter when you hear it. You can set the previous line's end to leave a pause. Check the resulting lines against the episode and trim the range where needed.

Preview depends on browser support for the episode's video and audio codecs. If the MKV cannot play, use a same-length preview file with the same time origin, or enter timestamps from your player. This release supports embedded ASS tracks and leaves the episode file untouched.

Searches send titles and artist names to LRCLIB. The app also sends the search text to AniList when it needs to look up title variants. Selected episodes, fonts, and projects are processed in memory and exported to your computer. Save a project ZIP before closing the page.

[Matroska subtitle parser](https://github.com/mathiasvr/matroska-subtitles) · [LRCLIB API](https://lrclib.net/docs.txt)
