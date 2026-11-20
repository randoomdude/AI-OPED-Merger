"""Create a timing draft from an episode chapter with locally installed Whisper."""

import argparse
from fractions import Fraction
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


CHAPTERS = {
    "OP": r"(?:(?:op|opening(?: credits)?|intro)(?:\s*\d+)?|オープニング)",
    "ED": r"(?:(?:ed|ending(?: credits)?|credits|end credits)(?:\s*\d+)?|エンディング)",
}


def timestamp(text):
    parts = text.strip().split(":")
    if len(parts) > 3 or not all(re.fullmatch(r"\d+", part) for part in parts[:-1]):
        raise ValueError("Use seconds or a time such as 0:01:34.00.")
    if not re.fullmatch(r"\d+(?:\.\d+)?", parts[-1]) or any(float(part) >= 60 for part in parts[1:]):
        raise ValueError("Use seconds or a time such as 0:01:34.00.")
    seconds = 0.0
    for part in parts:
        seconds = seconds * 60 + float(part)
    return seconds


def ffmpeg_binary():
    executable = shutil.which("ffmpeg")
    if not executable:
        candidate = Path("C:/ffmpeg/bin/ffmpeg.exe")
        executable = str(candidate) if candidate.is_file() else None
    if not executable:
        raise ValueError("FFmpeg is required. Install it and add it to your PATH.")
    return executable


def inspect(ffmpeg, path):
    result = subprocess.run([ffmpeg, "-nostdin", "-hide_banner", "-i", str(path), "-map_metadata", "0",
                             "-f", "ffmetadata", "-"], capture_output=True, timeout=30)
    info = result.stderr.decode("utf-8", errors="replace").split("Output #", 1)[0]
    if result.returncode:
        raise ValueError("FFmpeg could not open the selected episode.")
    streams = re.findall(r"^\s*Stream #0:(\d+)(?:\(([^)]+)\))?(?:\[[^]]+\])?: Audio:", info, re.M)
    if not streams:
        raise ValueError("No audio track was found in the selected episode.")
    stream = next((index for index, language in streams if language.lower().split("-")[0] in {"ja", "jpn"}), streams[0][0])
    chapters = []
    for section in result.stdout.decode("utf-8", errors="replace").split("[CHAPTER]")[1:]:
        fields = dict(line.split("=", 1) for line in section.splitlines() if "=" in line)
        if {"TIMEBASE", "START", "END"} <= fields.keys():
            unit = Fraction(fields["TIMEBASE"])
            chapters.append((fields.get("title", ""), float(int(fields["START"]) * unit), float(int(fields["END"]) * unit)))
    duration = re.search(r"Duration: (\d+:\d+:\d+\.\d+)", info)
    return stream, chapters, timestamp(duration[1]) if duration else float("inf")


def transcribe(ffmpeg, episode, stream, start, end, model_name):
    try:
        import numpy as np
        import torch
        import whisper
    except ImportError as error:
        raise ValueError("Install OpenAI Whisper in this Python environment first (python -m pip install openai-whisper).") from error

    result = subprocess.run([ffmpeg, "-nostdin", "-v", "error", "-ss", str(start), "-i", str(episode),
                             "-map", "0:" + stream, "-t", str(end - start), "-vn", "-ac", "1", "-ar", "16000",
                             "-f", "s16le", "-"], capture_output=True, timeout=60)
    if result.returncode or not result.stdout:
        raise ValueError("FFmpeg could not read audio in that part of the episode.")
    audio = np.frombuffer(result.stdout, dtype="<i2").astype(np.float32) / 32768
    device = "cuda" if torch.cuda.is_available() else "cpu"
    print(f"Transcribing {len(audio) / 16000:.1f} seconds with Whisper {model_name} on {device.upper()}…", flush=True)
    model = whisper.load_model(model_name, device=device)
    result = model.transcribe(audio, language="ja", task="transcribe", word_timestamps=True,
                              condition_on_previous_text=False, temperature=0, fp16=device == "cuda")
    clip_start = round(start * 1000)
    clip_end = min(round(end * 1000), clip_start + round(len(audio) / 16))

    def episode_ms(seconds):
        return max(clip_start, min(clip_end, clip_start + round(seconds * 1000)))

    segments = []
    for piece in result["segments"]:
        start_ms, end_ms = episode_ms(piece["start"]), episode_ms(piece["end"])
        if end_ms <= start_ms or not piece["text"].strip():
            continue
        words = []
        for word in piece.get("words", []):
            begin, finish = episode_ms(word["start"]), episode_ms(word["end"])
            if word["word"].strip() and finish >= begin:
                words.append({"start_ms": begin, "end_ms": finish, "text": word["word"]})
        segments.append({"start_ms": start_ms, "end_ms": end_ms, "text": piece["text"].strip(), "words": words})
    if not segments:
        raise ValueError("Whisper returned no lyric text for that window. Check that the theme is audible in the selected track.")
    return clip_start, clip_end, segments


def choose_episode():
    if os.name != "nt":
        return Path(input("MKV path: ").strip().strip('"'))
    picker = """
        [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
        Add-Type -AssemblyName System.Windows.Forms
        $picker = [Windows.Forms.OpenFileDialog]::new()
        $picker.Title = 'Choose the episode MKV'
        $picker.Filter = 'Matroska episode (*.mkv)|*.mkv'
        if ($picker.ShowDialog() -eq 'OK') { $picker.FileName }
    """
    result = subprocess.run(["powershell.exe", "-NoProfile", "-STA", "-Command", picker],
                            capture_output=True, check=True, encoding="utf-8")
    path = result.stdout.strip()
    return Path(path) if path else None


def write_result(output, content):
    data = json.dumps(content, ensure_ascii=False, indent=2)
    file = output.open("x", encoding="utf-8")
    try:
        with file:
            file.write(data + "\n")
    except OSError:
        output.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mkv", type=Path, nargs="?")
    parser.add_argument("--slot", choices=CHAPTERS)
    parser.add_argument("--start", type=timestamp)
    parser.add_argument("--end", type=timestamp)
    parser.add_argument("--model", default="medium", help="A multilingual Whisper model name (default: medium)")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    interactive = args.mkv is None
    try:
        episode = choose_episode() if interactive else args.mkv
        if episode is None:
            return 0
        if not episode.is_file() or episode.suffix.lower() != ".mkv":
            raise ValueError("Choose an existing .mkv file.")
        slot = args.slot or (input("Opening or ending? Enter OP or ED [OP]: ").strip().upper() if interactive else "") or "OP"
        if slot not in CHAPTERS:
            raise ValueError("Choose OP or ED.")
        ffmpeg = ffmpeg_binary()
        size = episode.stat().st_size
        stream, chapters, duration = inspect(ffmpeg, episode)
        chapter = next((item for item in chapters if re.fullmatch(CHAPTERS[slot], item[0].strip(), re.I)), None)
        start = args.start if args.start is not None else chapter[1] if chapter else None
        if start is None and interactive:
            start = timestamp(input("No matching chapter. Enter the song's episode start: "))
        if start is None:
            raise ValueError("No matching chapter. Pass --start to set the song's episode start.")
        chapter_end = chapter[2] if chapter and chapter[2] > start else float("inf")
        end = args.end if args.end is not None else min(start + 94, chapter_end, duration)
        if not 0 <= start < end <= duration:
            raise ValueError("The song window must fit inside the episode.")
        output = args.output or episode.with_name(episode.stem + f".{slot.lower()}.whisper.json")
        if output.exists():
            raise ValueError(f"{output.name} already exists. Pick another output path or move the previous timing file.")
        begin, finish, segments = transcribe(ffmpeg, episode, stream, start, end, args.model)
        if episode.stat().st_size != size:
            raise ValueError("The episode changed while it was being processed. Try the finished file.")
        write_result(output, {"format": "ai-oped-whisper", "version": 1, "mkv": episode.name, "mkv_size": size,
                              "slot": slot, "start_ms": begin, "end_ms": finish, "model": args.model, "segments": segments})
        print(f"\nSaved {output.resolve()}\nChoose Import Whisper timing in AI OP/ED Merger.")
        return 0
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"\nWhisper helper: {error}", file=sys.stderr)
        return 1
    finally:
        if interactive:
            input("\nPress Enter to close.")


if __name__ == "__main__":
    sys.exit(main())
