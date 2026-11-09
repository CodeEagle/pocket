# Archive reel provenance

`archive-route-reel.mp4` is a short, silent moving image made for the Lantern
story from its original generated archive illustration. It is not live-action
footage, a test colour-bar clip, or third-party material. The source artwork
and its Image Gen provenance are documented in `../../ASSETS.md`.

From `demo/js/apps/lantern`, regenerate the checked-in runtime file with
FFmpeg 8.1.1:

```sh
mkdir -p assets/videos
ffmpeg -hide_banner -loglevel error -y \
  -loop 1 -framerate 25 -i art/archive.png \
  -vf "zoompan=z='min(zoom+0.0014,1.10)':d=1:s=512x512:fps=25,format=yuv420p" \
  -frames:v 75 -an -c:v libx264 -profile:v baseline -level 3.0 \
  -preset medium -crf 22 -movflags +faststart \
  assets/videos/archive-route-reel.mp4
```

The filter adds only a slow 1.0× to 1.10× camera push over the existing
illustration. It does not add a route line, light flash, narration, or sound;
the player remains muted. The source `art/archive.png` is 512×512. The output
is H.264 Constrained Baseline, 512×512, yuv420p, 25fps, 3 seconds, and 75
frames. FFmpeg's decoded frame hashes differ at frames 0, 37, and 74, confirming
that the checked-in MP4 contains actual image motion rather than a static frame.
The runtime file SHA-256 is
`9224db6d0c66f62cde09ce94a7be5e5824803e08bd53613554957fea9cab4cb8`.

The video is registered as `archive_route_reel` in `novel.assets.json`; its
relative asset path is copied by the existing MiniApp asset pipeline into
`assets/apps/lantern/videos/`. It is not placed in the image PAK.
