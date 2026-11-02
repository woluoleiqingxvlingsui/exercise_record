/**
 * 单进程跑完全部测试。
 *
 * 为什么不用 `node --test tests/`：那会为每个测试文件 spawn 一个子进程并抓它的 stdio，
 * 而在受限沙箱里进程间管道不可用（spawn EPERM）。直接 import 进来在同一进程里跑，
 * 既绕开这个限制，又少一层进程开销。
 * 沙箱外照样可以用 `node --test tests/`，两种方式结果一致。
 */
import './util.test.js';
import './model.test.js';
import './store.test.js';
import './seed.test.js';
import './imports.test.js';
import './regress.test.js';
import './store-safety.test.js';
