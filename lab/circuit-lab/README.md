# Circuit Lab (S17)

A page for circuits practice in Safari on the iPad: sketch a prediction, then run the solver. No build, no release, nothing logged into the study system. It is the reference implementation for S24's sim block.

Written by a model for Adit. Not Adit's words. Every circuit is invented; none is a course problem.

## What it does

- **Switching** (7 first-order topologies, two with dependent sources). Each round draws standard values (E6 or E12, sources from a list) from a seed. Sketch the probe's response on symmetric axes with the Pencil, a finger or a mouse. Run is refused until the sketch has ink before t = 0 and covers 60% of the window after it. Run overlays the solver's curve and scores 0−, 0+, ∞, τ and the RMS shape error. Then ×½ or ×2 on any element asks for a new sketch (amber) over the earlier one (grey).
- **AC** (RC low-pass, RL high-pass, series RLC band-pass, inverting op-amp low-pass). Type the output phasor at one frequency, then Check shows every element's voltage and current and a phasor diagram. Sketch |H| in dB and ∠H over four decades, then Run sweep.
- **Pencil only** turns on with the first Pencil stroke, so a resting palm draws nothing.
- **Storage:** localStorage only (round counter, last circuit, a log of the last 300 scores), every access wrapped in try/catch.

The tolerances (`TOL` in `src/analysis.mjs`) are provisional. Adit's iPad check sets them for 0.16.

## Files

| file | what |
|---|---|
| `index.html` | the page: title, styles, root, one module script. No doctype: the artifact host wraps it |
| `src/mna.mjs` | the MNA solver: DC, transient with a t = 0 switch, AC |
| `src/circuits.mjs` | topologies: netlist, value draws, probe, schematic layout |
| `src/analysis.mjs` | 0−, 0+, ∞, τ (Thevenin resistance seen by the C or L), axes, phasors, sweep, scores |
| `src/schematic.mjs` | schematic SVG from the grid layout |
| `src/plot.mjs` | the SVG plot that takes ink |
| `src/lab.mjs` | the UI |

## Tests

```
node test/reference/check.mjs                      # the solver's 15 checks
node --test lab/circuit-lab/test/draws.test.mjs    # 20 seeded draws per topology, AC, schematics
python lab/circuit-lab/test/run_lab_test.py        # Chromium at 1280 and 390 px; screenshots to out/
```

## Publishing

Publish `index.html` as a private artifact with `src/*.mjs` as supporting files (content type `text/javascript`).
