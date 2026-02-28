import argparse
import shutil
import subprocess
from pathlib import Path

from companioncode import create_alignment_csv


def resolve_musescore_executable(user_provided: str | None) -> str:
	if user_provided:
		exe = Path(user_provided)
		if exe.exists():
			return str(exe)
		found = shutil.which(user_provided)
		if found:
			return found
		raise FileNotFoundError(f"MuseScore executable not found: {user_provided}")

	common_windows_paths = [
		Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
		Path(r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"),
	]

	for candidate in common_windows_paths:
		if candidate.exists():
			return str(candidate)

	for command_name in ["musescore", "mscore", "MuseScore4", "MuseScore3"]:
		found = shutil.which(command_name)
		if found:
			return found

	raise FileNotFoundError(
		"Could not find MuseScore executable. Pass --musescore "
		"with the full path (e.g. C:\\Program Files\\MuseScore 4\\bin\\MuseScore4.exe)."
	)


def run_musescore_export(musescore_exe: str, input_file: Path, output_file: Path) -> None:
	cmd = [musescore_exe, "-o", str(output_file), str(input_file)]
	result = subprocess.run(cmd, capture_output=True, text=True)
	if result.returncode != 0:
		raise RuntimeError(
			f"MuseScore export failed ({input_file} -> {output_file})\n"
			f"stdout:\n{result.stdout}\n\n"
			f"stderr:\n{result.stderr}"
		)


def build_outputs(midi_file: Path, out_dir: Path, basename: str | None) -> tuple[Path, Path, Path]:
	file_stem = basename if basename else midi_file.stem
	musicxml_path = out_dir / f"{file_stem}.musicxml"
	wav_path = out_dir / f"{file_stem}.wav"
	csv_path = out_dir / f"{file_stem}.csv"
	return musicxml_path, wav_path, csv_path


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Convert MIDI to MusicXML + WAV using MuseScore, then create alignment CSV."
	)
	parser.add_argument("midi_file", help="Path to input MIDI file (.mid/.midi)")
	parser.add_argument(
		"--out-dir",
		default=".",
		help="Output directory for generated files (default: current directory)",
	)
	parser.add_argument(
		"--basename",
		default=None,
		help="Optional base filename for outputs (without extension)",
	)
	parser.add_argument(
		"--musescore",
		default=None,
		help="Path or command name for MuseScore executable",
	)

	args = parser.parse_args()

	midi_file = Path(args.midi_file).expanduser().resolve()
	if not midi_file.exists():
		raise FileNotFoundError(f"MIDI file not found: {midi_file}")

	out_dir = Path(args.out_dir).expanduser().resolve()
	out_dir.mkdir(parents=True, exist_ok=True)

	musescore_exe = resolve_musescore_executable(args.musescore)
	musicxml_path, wav_path, csv_path = build_outputs(midi_file, out_dir, args.basename)

	run_musescore_export(musescore_exe, midi_file, musicxml_path)
	run_musescore_export(musescore_exe, midi_file, wav_path)

	create_alignment_csv(str(csv_path), str(musicxml_path))

	print("Done.")
	print(f"MusicXML: {musicxml_path}")
	print(f"WAV:      {wav_path}")
	print(f"CSV:      {csv_path}")


if __name__ == "__main__":
	main()
