import argparse
import shutil
import platform
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

	system = platform.system()
	common_paths: list[Path] = []

	if system == "Windows":
		common_paths = [
			Path(r"C:\Program Files\MuseScore 4\bin\MuseScore4.exe"),
			Path(r"C:\Program Files\MuseScore 3\bin\MuseScore3.exe"),
		]
	elif system == "Darwin":
		common_paths = [
			Path("/Applications/MuseScore 4.app/Contents/MacOS/mscore"),
			Path("/Applications/MuseScore 4.app/Contents/MacOS/MuseScore4"),
			Path("/Applications/MuseScore 3.app/Contents/MacOS/mscore"),
			Path("/Applications/MuseScore 3.app/Contents/MacOS/MuseScore3"),
			Path("~/Applications/MuseScore 4.app/Contents/MacOS/mscore").expanduser(),
			Path("~/Applications/MuseScore 3.app/Contents/MacOS/mscore").expanduser(),
		]

	for candidate in common_paths:
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


def find_midi_files(input_path: Path) -> list[Path]:
	if input_path.is_file():
		if input_path.suffix.lower() not in {".mid", ".midi"}:
			raise ValueError(f"Input file is not a MIDI: {input_path}")
		return [input_path]

	if input_path.is_dir():
		midi_files = [
			p for p in input_path.iterdir()
			if p.is_file() and p.suffix.lower() in {".mid", ".midi"}
		]
		if not midi_files:
			raise FileNotFoundError(f"No MIDI files found in directory: {input_path}")
		return sorted(midi_files, key=lambda p: p.name.lower())

	raise FileNotFoundError(f"Input path not found: {input_path}")


def build_target_dir(base_out_dir: Path, midi_file: Path) -> Path:
	target_dir = base_out_dir / midi_file.stem
	target_dir.mkdir(parents=True, exist_ok=True)
	return target_dir


def move_midi_to_target(midi_file: Path, target_dir: Path) -> Path:
	destination = target_dir / midi_file.name

	if midi_file.resolve() == destination.resolve():
		return destination

	if destination.exists():
		destination.unlink()

	shutil.move(str(midi_file), str(destination))
	return destination


def process_one_midi(musescore_exe: str, midi_file: Path, base_out_dir: Path, basename: str | None) -> tuple[Path, Path, Path, Path]:
	target_dir = build_target_dir(base_out_dir, midi_file)
	moved_midi = move_midi_to_target(midi_file, target_dir)
	musicxml_path, wav_path, csv_path = build_outputs(moved_midi, target_dir, basename)

	run_musescore_export(musescore_exe, moved_midi, musicxml_path)
	run_musescore_export(musescore_exe, moved_midi, wav_path)
	create_alignment_csv(str(csv_path), str(musicxml_path))

	return moved_midi, musicxml_path, wav_path, csv_path


def main() -> None:
	parser = argparse.ArgumentParser(
		description="Convert MIDI to MusicXML + WAV using MuseScore, then create alignment CSV."
	)
	parser.add_argument("input_path", help="Path to input MIDI file, or a directory containing MIDI files")
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

	input_path = Path(args.input_path).expanduser().resolve()

	out_dir = Path(args.out_dir).expanduser().resolve()
	out_dir.mkdir(parents=True, exist_ok=True)

	musescore_exe = resolve_musescore_executable(args.musescore)
	midi_files = find_midi_files(input_path)

	print(f"Processing {len(midi_files)} MIDI file(s)...")
	for midi_file in midi_files:
		moved_midi, musicxml_path, wav_path, csv_path = process_one_midi(
			musescore_exe,
			midi_file,
			out_dir,
			args.basename,
		)
		print("Done.")
		print(f"MIDI:     {moved_midi}")
		print(f"MusicXML: {musicxml_path}")
		print(f"WAV:      {wav_path}")
		print(f"CSV:      {csv_path}")


if __name__ == "__main__":
	main()
