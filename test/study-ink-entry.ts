// The anchored-ink module (src/study/ink) and the study parser for the browser test
// test/run_study_ink_test.py, as window.studyInk. Built by test/study-ink-build.mjs.
import { createInkApi, flushInk } from '../src/study/ink';
import * as model from '../src/study/ink/model';
import { parseStudyDoc } from '../src/study/format/parse';

(window as unknown as Record<string, unknown>).studyInk = { createInkApi, flushInk, model, parseStudyDoc };
