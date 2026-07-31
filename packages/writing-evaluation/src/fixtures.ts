/**
 * 固定原创中文评测 fixtures。
 *
 * 全部为本项目原创文本：不复制已出版小说，不使用用户私人文本。
 * 每个候选足以产生有意义的统计；expected relations 只验证工具能辨别
 * 预先设计的差异，不证明一般文章质量。
 *
 * 三个用例：
 * 1. restrained-reunion —— 克制 vs 过度解释；
 * 2. suspense-corridor —— 悬疑逐步释放 vs 重复絮叨；
 * 3. two-voice-dialogue —— 人物声音区分 vs 趋同。
 */

import type { WritingEvaluationSuiteV1 } from './schema.js';
import { validateSuite } from './validate.js';

const BASELINE_SUITE = {
  schemaVersion: 1,
  suiteId: 'gq1-baseline-v1',
  title: 'GQ1 写作评测基线套件 v1',
  description:
    '中文文章质量评测基线的第一批固定用例，用于验证评测工具能稳定辨别预先设计的文本差异。',
  locale: 'zh-CN',
  cases: [
    {
      caseId: 'restrained-reunion',
      title: '克制的重逢',
      description: '深夜站台重逢：一个用动作承载情绪，一个直接解释情绪。',
      contract: {
        premise: '一对多年未见的老友在深夜站台重逢，情绪藏在动作里，谁都没有说出真心话。',
        genre: ['当代都市'],
        tone: ['克制', '留白'],
        themes: ['重逢', '沉默'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_LIMITED',
        tense: 'PAST',
        protagonist: {
          characterKey: 'lin-zhou',
          name: '林舟',
          role: '主角',
          motivation: '想确认旧友近况',
          arc: '从沉默到更沉默',
          traits: ['寡言', '念旧'],
        },
        supportingCharacters: [
          {
            characterKey: 'shen-che',
            name: '沈澈',
            role: '老友',
            relationship: '多年未见的朋友',
          },
        ],
        relationships: [
          {
            relationshipKey: 'lin-shen-friendship',
            fromCharacterKey: 'lin-zhou',
            toCharacterKey: 'shen-che',
            type: '旧友',
          },
        ],
        worldRules: ['末班车深夜到站', '站台有路灯'],
        mustInclude: ['具体动作'],
        mustAvoid: ['直接解释情绪'],
      },
      sceneBrief: {
        sceneGoal: '克制地重逢，情绪不直接言说，用具体动作承载',
        participants: ['林舟', '沈澈'],
        location: '深夜的旧站台',
        entryState: ['两人五年未见', '沈澈刚下末班车', '林舟在站台等'],
        exitState: ['两人并肩走进夜雨', '谁也没有先开口'],
        conflict: '过去的误会没有答案，重逢只有一句客套',
        requiredFacts: ['沈澈坐末班车', '林舟在等车', '雨开始下'],
        forbiddenFacts: ['两人当场和解', '林舟说出真实情绪'],
        targetLength: { minCodePoints: 200, maxCodePoints: 400 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-station',
          phrase: '站台',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-air-freezes',
          phrase: '空气仿佛凝固',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 200,
          maxCodePoints: 400,
        },
        {
          kind: 'dialogue-ratio-range',
          constraintId: 'constraint.dialogue',
          minRatio: 0.02,
          maxRatio: 0.5,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-emotion',
          title: '情绪是否通过动作而非解释传达',
          rubric: '叙述者是否直接告诉读者角色的情绪，而不是通过动作、语气和环境来暗示。',
        },
      ],
      candidates: [
        {
          candidateId: 'restrained',
          strategyId: 'show-dont-tell-v1',
          modelId: 'fake-model',
          promptVersion: 'restrained-0.1',
          generationParameters: { temperature: 0.7, maxTokens: 512, seed: 'seed-restrained' },
          text: '末班车的灯光从隧道口漫出来，林舟把围巾往上拽了拽，指尖碰到衣领内侧，那里已经被雨洇湿了一小片。沈澈拖着行李箱走下台阶，轮子碾过积水，声音在空荡的站台里格外清楚。\n两个人在出口的灯柱下站定。沈澈先伸出手，林舟握了握，发现对方的手比自己的还冷。\n“你瘦了。”林舟说。\n沈澈笑了一下：“你也一样。”\n雨落在帽檐上，发出细密的声响。林舟没有问那封没有回的信，只是把伞往沈澈那边斜了一点。沈澈低着头，盯着自己鞋尖上的水渍，过了很久，才把伞接过去。',
        },
        {
          candidateId: 'over-explained',
          strategyId: 'tell-dont-show-v1',
          modelId: 'fake-model',
          promptVersion: 'over-explained-0.1',
          generationParameters: { temperature: 0.9, maxTokens: 512, seed: 'seed-over' },
          text: '在空荡的站台再次见到沈澈的那一刻，林舟的心跳仿佛漏了一拍，他心中一阵酸楚，几乎无法呼吸。空气仿佛凝固了，五年的时光在这一刻被无限拉长。\n他不知为何眼眶微微发红，竟然忍不住别过头去。沈澈的身影似乎比记忆里更加疲惫，林舟不禁想，这些年他一定过得很辛苦。\n“你……你还好吗？”林舟终于开口，声音仿佛有些哽咽。\n沈澈似乎也察觉到了什么，轻轻叹了口气，莫名地有些尴尬。这一刻，两人都没有说话，林舟心中一阵翻滚，所有的委屈与思念都堵在喉咙里。',
        },
      ],
      expectedRelations: [
        {
          metricId: 'ai-smell.totalCount',
          leftCandidateId: 'over-explained',
          operator: 'GT',
          rightCandidateId: 'restrained',
        },
        {
          metricId: 'ai-smell.totalPerThousandCodePoints',
          leftCandidateId: 'over-explained',
          operator: 'GT',
          rightCandidateId: 'restrained',
        },
      ],
    },
    {
      caseId: 'suspense-corridor',
      title: '悬疑走廊',
      description: '深夜走廊听见声音：一个逐步释放信息，一个反复重复同一句警告。',
      contract: {
        premise: '独居青年深夜回家，在昏暗走廊里听见不该存在的声音，始终没有揭开真相。',
        genre: ['悬疑', '都市'],
        tone: ['压抑', '克制'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_LIMITED',
        tense: 'PRESENT',
        protagonist: {
          characterKey: 'gu-yao',
          name: '顾遥',
          role: '主角',
          motivation: '回到自己的公寓',
          arc: '从松弛到警惕',
        },
        worldRules: ['走廊声控灯时好时坏', '三层尽头是401室'],
        mustAvoid: ['过早解释真相'],
      },
      sceneBrief: {
        sceneGoal: '悬疑推进，信息逐步释放，不重复',
        participants: ['顾遥', '不明声响'],
        location: '旧公寓三层的走廊',
        entryState: ['顾遥独自回家', '走廊灯坏了两盏', '尽头是401室'],
        exitState: ['顾遥退到楼梯口，决定不回家'],
        conflict: '走廊尽头传来不属于任何邻居的声音',
        requiredFacts: ['走廊尽头有声响', '灯在闪', '顾遥停住脚步'],
        forbiddenFacts: ['声音来源被解释', '怪物或人直接登场'],
        targetLength: { minCodePoints: 200, maxCodePoints: 400 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-corridor',
          phrase: '走廊',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-explanation',
          phrase: '是楼下的猫',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 200,
          maxCodePoints: 400,
        },
        {
          kind: 'dialogue-ratio-range',
          constraintId: 'constraint.dialogue',
          minRatio: 0,
          maxRatio: 0.2,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-suspense',
          title: '是否过早解释真相',
          rubric: '文本是否在结尾前解释了声音来源；信息是逐步释放还是重复。',
        },
      ],
      candidates: [
        {
          candidateId: 'controlled-reveal',
          strategyId: 'controlled-reveal-v1',
          modelId: 'fake-model',
          promptVersion: 'controlled-0.1',
          generationParameters: { temperature: 0.7, maxTokens: 512, seed: 'seed-controlled' },
          text: '走廊的灯在头顶闪了一下，又灭了。顾遥站在三楼拐角，钥匙插在锁孔里，指腹能感觉到金属的凉。\n尽头那扇门后面有声音。很轻，像什么东西在门板上刮过，一下，又一下，停了很久，又刮了一下。\n顾遥把钥匙拔了出来。他没有往前看，也没有退，走廊里只有他自己的呼吸声。\n路灯的光从窗缝里漏进来，在地板上拉出一条细长的亮线。那声音又响了，这次离得更近了一点。\n他转身，脚步声很轻地往楼梯口走。身后的门没有再响，但他没有回头看。',
        },
        {
          candidateId: 'repetitive-reveal',
          strategyId: 'repetitive-reveal-v1',
          modelId: 'fake-model',
          promptVersion: 'repetitive-0.1',
          generationParameters: { temperature: 0.9, maxTokens: 512, seed: 'seed-repetitive' },
          text: '走廊的灯闪了一下。顾遥停住脚步。走廊的灯又闪了一下。顾遥握紧了钥匙。\n他告诉自己不要回头。他告诉自己不要回头。那声音又响了。那声音又响了。顾遥告诉自己不要回头。\n走廊尽头有什么东西在动。走廊尽头有什么东西在动。顾遥咽了一下口水，握紧了钥匙。\n他告诉自己不要回头。他告诉自己不要回头。那声音又响了。那声音又响了。顾遥退了半步。\n走廊的灯又闪了一下。顾遥告诉自己不要回头。那声音又响了。\n那声音又响了。顾遥退了半步。',
        },
      ],
      expectedRelations: [
        {
          metricId: 'repetition.duplicateSentenceRatio',
          leftCandidateId: 'repetitive-reveal',
          operator: 'GT',
          rightCandidateId: 'controlled-reveal',
        },
        {
          metricId: 'repetition.repeatedSentenceOpenerRatio',
          leftCandidateId: 'repetitive-reveal',
          operator: 'GT',
          rightCandidateId: 'controlled-reveal',
        },
        {
          metricId: 'repetition.repeatedCharacterNgramRatio.3',
          leftCandidateId: 'repetitive-reveal',
          operator: 'GT',
          rightCandidateId: 'controlled-reveal',
        },
      ],
    },
    {
      caseId: 'two-voice-dialogue',
      title: '双声对话',
      description: '深夜面馆：两个角色的声音一个可区分，一个趋同。',
      contract: {
        premise: '两个陌生人深夜在小面馆同桌吃面，话语里藏着各自的心事。',
        genre: ['都市', '日常'],
        tone: ['轻巧', '留白'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_LIMITED',
        tense: 'PRESENT',
        protagonist: {
          characterKey: 'chen-mo',
          name: '陈默',
          role: '主角',
          motivation: '一个人吃宵夜',
          arc: '从保持距离到主动搭话',
        },
        supportingCharacters: [
          {
            characterKey: 'a-he',
            name: '阿禾',
            role: '陌生人',
            relationship: '同桌的陌生人',
          },
        ],
        relationships: [
          {
            relationshipKey: 'chen-he-encounter',
            fromCharacterKey: 'chen-mo',
            toCharacterKey: 'a-he',
            type: '一面之缘',
          },
        ],
        worldRules: ['面馆深夜营业到两点', '阳春面十二元一碗'],
        mustAvoid: ['直接互问职业'],
      },
      sceneBrief: {
        sceneGoal: '两个角色声音区分，保持潜台词',
        participants: ['陈默', '阿禾'],
        location: '深夜的小面馆',
        entryState: ['陈默是常客', '阿禾第一次来', '两个人都很饿'],
        exitState: ['两人约好下次再来', '谁也没说破彼此的身份'],
        conflict: '一个想搭话，一个想保持距离',
        requiredFacts: ['两碗面', '面钱', '打烊时间'],
        forbiddenFacts: ['两人直接互问职业'],
        targetLength: { minCodePoints: 250, maxCodePoints: 450 },
      },
      constraints: [
        {
          kind: 'dialogue-ratio-range',
          constraintId: 'constraint.dialogue',
          minRatio: 0.3,
          maxRatio: 0.85,
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 250,
          maxCodePoints: 450,
        },
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-noodles',
          phrase: '面',
          minOccurrences: 2,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-didactic',
          phrase: '人生感悟',
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-voice',
          title: '两个角色的说话方式是否可区分',
          rubric: '只看台词，能否分辨哪句是陈默、哪句是阿禾。',
        },
      ],
      candidates: [
        {
          candidateId: 'distinct-voices',
          strategyId: 'distinct-voice-v1',
          modelId: 'fake-model',
          promptVersion: 'distinct-0.1',
          generationParameters: { temperature: 0.8, maxTokens: 512, seed: 'seed-distinct' },
          text: '凌晨两点的面馆里只剩两盏灯，热气把窗玻璃熏出一层雾。\n“老板，一碗阳春面，多放葱花。”陈默的声音很平，像在报菜单。\n阿禾在对面坐下，看他把辣油搅进汤里，才小声说：“那……我也来一碗一样的。”\n陈默抬头：“能吃辣吗？”\n阿禾摇头：“不太能。”\n“那换清汤。”陈默头也没抬，把筷子在碗沿磕齐。\n阿禾低着头，指尖在桌面上划了划：“多少钱？”\n“十二。”陈默报完价，又补一句，“面钱我先付，你下次还我。”\n“为什么？”\n“因为你看起来不会带钱包。”\n阿禾被噎了一下，倒笑了。陈默不答，埋头吃面，汤底见了才抬头。\n付钱的时候，阿禾忽然说：“你请的面，我记着了。”\n陈默嗯了一声，推开门，冷风灌进来。他没回头：“下次你请。”\n雨还在下。两个人在门廊下站了一会儿，谁都没说再见。',
        },
        {
          candidateId: 'homogenized-voices',
          strategyId: 'homogenized-voice-v1',
          modelId: 'fake-model',
          promptVersion: 'homogenized-0.1',
          generationParameters: { temperature: 0.8, maxTokens: 512, seed: 'seed-homogenized' },
          text: '老板端上面的时候，陈默和阿禾都在看窗外的雨。雨声很密，两个人谁也没有先动筷子。\n“一碗阳春面，多放葱花。”陈默说。\n“那我也来一碗一样的吧。”阿禾说。\n“你能吃辣吗？”陈默问。\n“我不太能吃辣吧。”阿禾说。\n“那换清汤吧。”陈默说。\n“那面多少钱呢？”阿禾问。\n“十二。”陈默说。\n“那这顿面钱我先付吧。”陈默说。\n“那为什么呢？”阿禾问。\n“因为你看起来不会带钱包吧。”陈默说。\n“那好吧，那谢谢你啦。”阿禾说。\n“那面汤要趁热喝吧。”阿禾说。\n“嗯，趁热喝吧。”陈默说。\n“那你住得远吗？”阿禾问。\n“不算远吧。”陈默说。\n“那明天还来吗？”阿禾问。\n“看看吧。”陈默说。\n面汤的热气慢慢散了。陈默和阿禾都没有再说话。',
        },
      ],
      expectedRelations: [
        {
          metricId: 'repetition.repeatedSentenceOpenerRatio',
          leftCandidateId: 'homogenized-voices',
          operator: 'GT',
          rightCandidateId: 'distinct-voices',
        },
        {
          metricId: 'repetition.repeatedCharacterNgramRatio.2',
          leftCandidateId: 'homogenized-voices',
          operator: 'GT',
          rightCandidateId: 'distinct-voices',
        },
      ],
    },
  ],
};

/**
 * 返回通过完整运行时验证的 baseline suite。
 * 每个用例、每个候选文本都会在读取时被验证；fixture 有任何 schema 问题会立即抛错。
 */
export function getBaselineSuite(): WritingEvaluationSuiteV1 {
  return validateSuite(BASELINE_SUITE);
}
