/**
 * seed.js —— 内置示例计划。
 *
 * 首次打开时铺一份，让用户一进来就能看到完整结构（而不是空页面干瞪眼）；
 * 之后可以随意改、也可以删。示例数据本身也是验收测试的素材。
 */

import { uid } from './util.js';

const rest = (ms) => ms;

export function seedPlans() {
  return [
    // ------------------------------------------------------------ 力量
    {
      id: uid('plan'),
      name: '引体日',
      category: 'strength',
      tags: ['背部', '拉力'],
      note: '热身做足再上正式组；最后一组后多歇一会儿再收操。',
      stages: [
        {
          id: uid('st'), kind: 'warmup', name: '热身', items: [
            {
              id: uid('it'), name: '弹力带肩袖外旋', mode: 'reps',
              defaultRestMs: rest(45000),
              sets: { repeat: 2, of: { reps: 15, note: '轻阻力，慢速控制' } },
            },
            {
              id: uid('it'), name: '悬垂肩胛下沉', mode: 'reps',
              defaultRestMs: rest(45000), sets: { repeat: 2, of: { reps: 8 } },
            },
          ],
        },
        {
          id: uid('st'), kind: 'main', name: '正式组',
          items: [
            {
              id: uid('it'), name: '引体向上', mode: 'reps',
              defaultRestMs: rest(90000), // 三组递减次数（逐组编辑）
              sets: [
                { reps: 8, weightKg: 0, note: '留 2 次余力' },
                { reps: 8, weightKg: 0 },
                { reps: 6, weightKg: 0, note: '力竭组' },
              ],
            },
          ],
        },
        {
          id: uid('st'), kind: 'cooldown', name: '放松',
          items: [
            {
              id: uid('it'), name: '悬垂放松', mode: 'duration',
              defaultRestMs: rest(30000),
              sets: { repeat: 3, of: { durationS: 20 } },
            },
          ],
        },
      ],
    },
    {
      id: uid('plan'),
      name: '推日（卧推为主）',
      category: 'strength',
      tags: ['胸', '推力'],
      note: '热身组用空杆过渡，别一上来就压大重量。',
      stages: [
        {
          id: uid('st'), kind: 'warmup', name: '热身', items: [
            { id: uid('it'), name: '空杆卧推', mode: 'reps', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { reps: 15, weightKg: 20 } } },
            { id: uid('it'), name: '肩部绕环', mode: 'reps', defaultRestMs: rest(45000),
              sets: { repeat: 2, of: { reps: 12 } } },
          ],
        },
        {
          id: uid('st'), kind: 'main', name: '正式组',
          items: [
            { id: uid('it'), name: '杠铃卧推', mode: 'reps',
              defaultRestMs: rest(150000), sets: { repeat: 4, of: { reps: 6, weightKg: 60 } } },
            { id: uid('it'), name: '哑铃肩推', mode: 'reps',
              defaultRestMs: rest(90000),
              sets: { repeat: 3, of: { reps: 10, weightKg: 16 } } },
          ],
        },
      ],
    },

    // ------------------------------------------------------------ 有氧
    {
      id: uid('plan'),
      name: '日常有氧跑',
      category: 'cardio',
      tags: ['有氧', '轻松跑'],
      note: '能一边说话不喘的强度，别赶配速。',
      stages: [
        {
          id: uid('st'), kind: 'warmup', name: '热身', items: [
            { id: uid('it'), name: '慢跑热身', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { distanceKm: 1 } } },
            { id: uid('it'), name: '动态拉伸', mode: 'duration', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { durationS: 300, note: '高抬腿/后踢腿/弓步走' } } },
          ],
        },
        {
          id: uid('st'), kind: 'main', name: '主课',
          items: [
            { id: uid('it'), name: '有氧跑', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { distanceKm: 6, paceSPerKm: 380, note: '6:00–6:20 /km' } } },
          ],
        },
        {
          id: uid('st'), kind: 'cooldown', name: '放松',
          items: [
            { id: uid('it'), name: '慢走放松', mode: 'distance', defaultRestMs: rest(0),
              sets: { repeat: 1, of: { distanceKm: 0.4 } } },
          ],
        },
      ],
    },
    {
      id: uid('plan'),
      name: '强度跑（1000m 间歇）',
      category: 'cardio',
      tags: ['有氧', '间歇', '高强度'],
      note: '间歇日尽量安排在体力好的那天；组间慢跑别停死。',
      stages: [
        {
          id: uid('st'), kind: 'warmup', name: '热身', items: [
            { id: uid('it'), name: '慢跑热身', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { distanceKm: 1.5 } } },
            { id: uid('it'), name: '动态加速跑', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 4, of: { distanceKm: 0.1 } } },
          ],
        },
        {
          id: uid('st'), kind: 'main', name: '主课',
          items: [
            { id: uid('it'), name: '1000m 间歇', mode: 'distance',
              defaultRestMs: rest(120000), sets: { repeat: 4, of: { distanceKm: 1, paceSPerKm: 250, note: '4:10 /km' } } },
          ],
        },
        {
          id: uid('st'), kind: 'cooldown', name: '放松',
          items: [
            { id: uid('it'), name: '慢跑放松', mode: 'distance', defaultRestMs: rest(0),
              sets: { repeat: 1, of: { distanceKm: 1 } } },
          ],
        },
      ],
    },
    {
      id: uid('plan'),
      name: '长距离跑',
      category: 'cardio',
      tags: ['有氧', '耐力'],
      note: '前 2km 刻意压慢，把体力留给后半程。',
      stages: [
        {
          id: uid('st'), kind: 'warmup', name: '热身', items: [
            { id: uid('it'), name: '慢跑热身', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { distanceKm: 1 } } },
            { id: uid('it'), name: '动态拉伸', mode: 'duration', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { durationS: 300 } } },
          ],
        },
        {
          id: uid('st'), kind: 'main', name: '主课',
          items: [
            { id: uid('it'), name: '长距离跑', mode: 'distance', defaultRestMs: rest(60000),
              sets: { repeat: 1, of: { distanceKm: 15, paceSPerKm: 385, note: '6:10–6:40 /km' } } },
          ],
        },
        {
          id: uid('st'), kind: 'cooldown', name: '放松',
          items: [
            { id: uid('it'), name: '慢走放松', mode: 'distance', defaultRestMs: rest(0),
              sets: { repeat: 1, of: { distanceKm: 0.8 } } },
          ],
        },
      ],
    },
  ];
}

/** 首次启动判断：一个计划都没有时才铺示例 */
export function shouldSeed(existingPlans) {
  return !existingPlans || existingPlans.length === 0;
}
