# Viewer demo GIF

`docs/consensus-viewer.gif` is made from real viewer frames: `capture.mjs` plays a short story into a throwaway consensus (its own `CONSENSUS_HOME`, nothing touches your real state) and saves a `--once` frame on every pass; `render.py` draws the frames to PNG; ffmpeg joins them with their real timing.

```bash
node docs/demo/capture.mjs consensus-claude-plugin <work-dir> 104 26
python docs/demo/render.py <work-dir>/frames 104 26      # needs Pillow; uses Cascadia Mono + Segoe UI Symbol (Windows fonts)
cd <work-dir>/frames && node -e 'const t=require("./times.json");let s="";for(let i=0;i<t.length;i++){const d=i+1<t.length?(t[i+1]-t[i])/1000:2;s+=`file ${String(i).padStart(4,"0")}.png\nduration ${d}\n`}s+=`file ${String(t.length-1).padStart(4,"0")}.png\n`;require("fs").writeFileSync("list.txt",s)'
ffmpeg -f concat -safe 0 -i list.txt -vf "fps=12,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" -loop 0 consensus-viewer.gif
```

Regenerate it when the viewer's look changes.
