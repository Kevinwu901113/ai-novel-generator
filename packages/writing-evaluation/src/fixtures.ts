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

const GQ2_PLACEHOLDER_TEXT =
  '占位候选：本 case 仅作为 gq2 生成源存在；此正文不参与真实生成，也不会被 suite-io 复制进 output suite。';

function gq2PlaceholderCandidate(caseId: string) {
  return {
    candidateId: `placeholder-${caseId}`,
    strategyId: 'gq2-source-placeholder-v1',
    modelId: 'not-used',
    promptVersion: 'gq2-source-v1',
    generationParameters: { temperature: null, maxTokens: null, seed: null },
    text: GQ2_PLACEHOLDER_TEXT,
  };
}

/**
 * GQ2 题材覆盖压力测试套件。
 *
 * 与 gq1 的分辨力用途不同：gq2 是生成源套件，candidates 为 schema 占位，
 * 不参与真实生成，也不复制进 output suite（见 writing-experiment-runner/suite-io.ts）。
 * 压力点设计见各 case 的 mustAvoid / forbiddenFacts / manual-criterion。
 */
export const GENRE_COVERAGE_SUITE: WritingEvaluationSuiteV1 = validateSuite({
  schemaVersion: 1,
  suiteId: 'gq2-genre-coverage-v1',
  title: 'GQ2 题材覆盖压力测试套件 v1',
  description:
    '修正 gq1 的系统性覆盖偏差：覆盖 4 种视角、3 种时态、克制与浓烈两端语气，以及当代都市、悬疑、日常、古言、幻想、志怪、动作、现代情感等题材。',
  locale: 'zh-CN',
  cases: [
    {
      ...BASELINE_SUITE.cases[0],
      sceneBrief: {
        sceneGoal: '克制地重逢，情绪不直接言说，用具体动作与旧物承载五年空白',
        participants: ['林舟', '沈澈'],
        location: '深夜翻修中的旧站台北出口',
        entryState: [
          '两人五年未见，只从同学群里知道对方回城',
          '沈澈坐的末班车晚点十七分钟',
          '林舟在站台等了四十分钟，手里拿着两把伞',
          '旧站台南出口封闭，只剩北出口一条路',
          '雨在末班车进站前开始下',
        ],
        exitState: [
          '两人并肩走出北出口',
          '经过一盏忽明忽暗的路灯',
          '林舟把没拆封的那把伞递给沈澈',
          '沈澈接过伞，没有撑开',
          '谁也没有先开口',
        ],
        conflict:
          '林舟想问五年前那封长信为何没有回音，沈澈想解释又怕一开口就把重逢变成旧账；两人只能借末班车、雨伞和改道的出口拖延，把真话压在一次又一次客套下面。',
        requiredFacts: [
          '末班车晚点十七分钟',
          '林舟带了两把伞',
          '南出口封闭，北出口仍开放',
          '沈澈的行李箱轮子坏了',
          '雨在进站前开始下',
          '经过一盏忽明忽暗的路灯',
          '林舟把没拆封的伞递给沈澈',
          '两人都没有提那封信',
        ],
        forbiddenFacts: ['两人当场和解', '林舟说出真实情绪', '沈澈当场解释当年失联原因'],
        targetLength: { minCodePoints: 850, maxCodePoints: 1400 },
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
          minCodePoints: 850,
          maxCodePoints: 1400,
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
    },
    {
      ...BASELINE_SUITE.cases[1],
      sceneBrief: {
        sceneGoal: '悬疑推进，信息逐步释放，让每次声响和后退都有新的可写细节',
        participants: ['顾遥', '不明声响'],
        location: '旧公寓三层走廊与消防楼梯口',
        entryState: [
          '顾遥加班到十一点半，从消防楼梯进楼',
          '一层门禁没有关严',
          '三层走廊两盏灯坏着，只剩安全出口灯亮',
          '401室在走廊尽头，已经空置三个月',
          '顾遥手里拎着便利店袋子和门禁卡',
        ],
        exitState: [
          '顾遥退到消防楼梯口',
          '手里的门禁卡掉在楼梯上',
          '他决定去楼下二十四小时便利店过夜',
          '身后那扇门没有再响',
        ],
        conflict:
          '顾遥必须经过401室才能到家，但空置了三个月的门后不断传来刮擦声；他既怕那是贼，又怕不是贼，而手机只剩最后一格电，报警和走近都成了赌注。',
        requiredFacts: [
          '顾遥从消防楼梯进入',
          '一层门禁没有关严',
          '三层只亮安全出口灯',
          '401室已空置三个月',
          '门后传来两次不同的刮擦声',
          '顾遥的手机只剩最后一格电',
          '顾遥退到消防楼梯口',
          '门禁卡掉在楼梯上',
        ],
        forbiddenFacts: ['声音来源被解释', '怪物或人直接登场', '顾遥打开401室的门'],
        targetLength: { minCodePoints: 850, maxCodePoints: 1450 },
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
          minCodePoints: 850,
          maxCodePoints: 1450,
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
    },
    {
      ...BASELINE_SUITE.cases[2],
      sceneBrief: {
        sceneGoal: '两个角色声音区分，保持潜台词，借点餐、打烊和雨停后的门廊推进对话',
        participants: ['陈默', '阿禾'],
        location: '深夜的小面馆与门廊',
        entryState: [
          '陈默刚下夜班，常坐靠门第二张桌',
          '阿禾第一次来，站在菜单前犹豫',
          '两人都饿着，但店里只剩一个炉头',
          '外面雨刚停，地上还汪着水',
          '老板正在擦最后两张桌子，两点打烊',
        ],
        exitState: [
          '两人约好下次由阿禾请客',
          '谁也没说破彼此的身份',
          '陈默先推门出去，站在门廊下等雨停',
          '阿禾记下墙上的营业时间',
        ],
        conflict:
          '陈默想借一碗面把陌生人的话匣子打开，阿禾却只答最省事的短句；两人都听出对方有没说完的事，又都不愿在打烊前先亮底牌。',
        requiredFacts: [
          '两碗阳春面',
          '面钱十二元一碗',
          '两点打烊',
          '陈默坐靠门第二张桌',
          '阿禾第一次来',
          '雨刚停',
          '阿禾记下墙上的营业时间',
          '陈默先推门出去',
        ],
        forbiddenFacts: ['两人直接互问职业', '两人交换联系方式'],
        targetLength: { minCodePoints: 850, maxCodePoints: 1400 },
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
          minCodePoints: 850,
          maxCodePoints: 1400,
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
    },
    {
      caseId: 'palace-farewell',
      title: '宫门落钥',
      description: '第一人称古代宫廷言情：旧誓藏在还回的玉佩里，语域不得滑向直陈情绪或现代词。',
      contract: {
        premise:
          '前朝女官在宫门落钥前最后一次送别即将远赴边关的将军，两人守着旧誓却不越礼，借还回旧物完成告别。',
        genre: ['古代宫廷', '言情'],
        tone: ['克制', '典雅', '怅然'],
        themes: ['离别', '君臣之礼', '旧誓'],
        targetAudience: '成人向网文读者',
        narrativePov: 'FIRST',
        tense: 'PAST',
        protagonist: {
          characterKey: 'jiang-ci',
          name: '江慈',
          role: '女官',
          motivation: '在落钥前了结旧约',
          arc: '从执念到松手',
          traits: ['守礼', '清醒', '念旧'],
        },
        supportingCharacters: [
          {
            characterKey: 'wei-heng',
            name: '卫衡',
            role: '边关将领',
            relationship: '曾有婚约',
          },
        ],
        relationships: [
          {
            relationshipKey: 'jiang-wei-betrothal',
            fromCharacterKey: 'jiang-ci',
            toCharacterKey: 'wei-heng',
            type: '旧约',
            dynamic: '君臣礼法下的未成婚约',
          },
        ],
        worldRules: ['宫门戌时落钥', '禁军巡夜不许私会', '边关军报不得留京过夜'],
        mustInclude: ['宫门', '旧玉佩', '落钥钟声', '具体动作'],
        mustAvoid: ['现代词汇', '翻译腔', '直接说出情绪名词'],
      },
      sceneBrief: {
        sceneGoal: '第一人称内省保持语域统一，情绪借旧物与礼数外显，并以落钥前的多个动作延展告别',
        participants: ['江慈', '卫衡'],
        location: '皇宫西侧门甬道',
        entryState: [
          '卫衡天亮随军开拔，今夜宿在宫门外营房',
          '江慈趁换值空隙从女官值房出来',
          '戌时钟已经响过一声，宫门只留半扇',
          '江慈把旧玉佩包在帕子里带出来',
          '甬道两侧石灯只点着西边一盏',
        ],
        exitState: [
          '江慈最终收回旧玉佩',
          '卫衡把一包伤药塞进她手里',
          '落钥钟响第二声，宫门合拢',
          '江慈退到门内，看着门缝里的身影消失',
        ],
        conflict:
          '江慈想当面把旧约问清楚，卫衡却只谈边关与礼数；两人都知道过了今夜再无见面理由，但谁也不能在宫门落钥前迈过臣礼那一步。',
        requiredFacts: [
          '戌时钟已响一声',
          '半扇宫门',
          '旧玉佩包在帕子里',
          '卫衡归还旧玉佩',
          '江慈行了臣礼',
          '卫衡塞给她一包伤药',
          '落钥钟响第二声',
          '宫门关闭',
        ],
        forbiddenFacts: [
          '出现手机、OK、情绪管理之类的现代词',
          '翻译腔句式',
          '直陈“我很难过”之类情绪',
          '江慈越过宫门与卫衡私奔',
          '卫衡留京过夜',
        ],
        targetLength: { minCodePoints: 850, maxCodePoints: 1450 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-palace-gate',
          phrase: '宫门',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-direct-sadness',
          phrase: '我很难过',
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-modern-word',
          phrase: '情绪',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 850,
          maxCodePoints: 1450,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-register',
          title: '语域是否稳定在古言',
          rubric:
            '第一人称内省是否滑向直陈情绪；是否出现现代词汇、网络语或翻译腔；称谓与礼数是否自洽。',
        },
      ],
      candidates: [gq2PlaceholderCandidate('palace-farewell')],
    },
    {
      caseId: 'frontier-ledger',
      title: '边镇霜晶',
      description: '异世界幻想第三人称限知现在时：入城税规则必须从动作与对白中透出。',
      contract: {
        premise:
          '内地账房第一次来到异世界边镇，必须在日落前缴清入城税；她很快发现税官称量的不是银钱。',
        genre: ['幻想', '异世界'],
        tone: ['冷峻', '克制', '异质感'],
        themes: ['陌生世界的规则', '以物易物', '身份'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_LIMITED',
        tense: 'PRESENT',
        protagonist: {
          characterKey: 'luo-xian',
          name: '洛弦',
          role: '随行账房',
          motivation: '在日落前缴清入城税',
          arc: '从照搬旧法到学会本地规则',
          traits: ['谨慎', '善算', '寡言'],
        },
        supportingCharacters: [
          {
            characterKey: 'zhuo-yan',
            name: '卓岩',
            role: '商队领队',
            relationship: '雇佣关系',
          },
          {
            characterKey: 'lin-kui',
            name: '林葵',
            role: '税官',
            relationship: '素不相识',
          },
        ],
        relationships: [
          {
            relationshipKey: 'luo-zhuo-employment',
            fromCharacterKey: 'luo-xian',
            toCharacterKey: 'zhuo-yan',
            type: '雇佣',
            dynamic: '洛弦随队记账',
          },
          {
            relationshipKey: 'luo-lin-encounter',
            fromCharacterKey: 'luo-xian',
            toCharacterKey: 'lin-kui',
            type: '交涉',
            dynamic: '在税棚第一次照面',
          },
        ],
        worldRules: ['入城税用霜晶支付', '霜晶遇体温会雾化', '边镇日落前关城门', '记忆可被称重'],
        mustInclude: ['霜晶', '动作中的设定细节', '至少两句对白解释规则'],
        mustAvoid: ['清单式环境陈列', '信息倾倒', '百科式设定说明'],
      },
      sceneBrief: {
        sceneGoal: '通过动作与对白让异世界规则自然露出，以缴税尝试的多次失败推进设定',
        participants: ['洛弦', '卓岩', '林葵'],
        location: '边镇城门外的临时税棚',
        entryState: [
          '商队带着三车药材被拦在城门外',
          '洛弦第一次随商队来到此地',
          '税官林葵坐在税棚后，面前只有一架空天平',
          '洛弦掏出碎银，被卓岩拦下',
          '日落只剩半个时辰',
        ],
        exitState: [
          '洛弦把霜晶从帕子里剥出来',
          '天平称量她的记忆后翘起',
          '林葵在名册上盖了章',
          '商队进门，城门在身后合上',
        ],
        conflict:
          '洛弦的旧账本与银钱在这里都行不通；林葵要的是会雾化的霜晶和一段可称重的记忆。她越是想用熟知的规则，越发现自己连“税”是什么都没弄懂。',
        requiredFacts: [
          '霜晶包在帕子里',
          '称量记忆的天平',
          '日落前关城门',
          '洛弦先递出碎银',
          '卓岩拦住碎银',
          '林葵称量记忆',
          '名册盖章',
          '城门合上',
        ],
        forbiddenFacts: [
          '一段连续三句以上的环境介绍',
          '“这个世界分为……”式背景说明',
          '林葵收下银钱',
        ],
        targetLength: { minCodePoints: 850, maxCodePoints: 1500 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-frost-crystal',
          phrase: '霜晶',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-world-info-dump',
          phrase: '这个世界',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 850,
          maxCodePoints: 1500,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-setting',
          title: '设定是否由动作与对白承载',
          rubric: '是否出现清单式环境陈列或连续背景介绍；规则是否在人物选择与对话中显现。',
        },
      ],
      candidates: [gq2PlaceholderCandidate('frontier-ledger')],
    },
    {
      caseId: 'folk-night-rite',
      title: '七月十四水灯',
      description: '民俗志怪第三人称全知过去时：年代与地方质感靠油纸、竹篾与旧称承载。',
      contract: {
        premise:
          '民国二十三年七月十四，沿江小镇照例在渡口放水灯野祭；守渡老人发现今年多出一盏没有名字的灯。',
        genre: ['民俗志怪', '年代'],
        tone: ['幽微', '克制', '乡土'],
        themes: ['野祭', '亡魂', '守渡'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_OMNISCIENT',
        tense: 'PAST',
        protagonist: {
          characterKey: 'yan-shan',
          name: '严三',
          role: '守渡老人',
          motivation: '在天亮前按旧例收回水灯',
          arc: '从避讳到认出那盏灯',
          traits: ['信俗', '寡言', '守旧'],
        },
        supportingCharacters: [
          {
            characterKey: 'xiu-lan',
            name: '秀兰',
            role: '摆渡妇',
            relationship: '乡邻',
          },
        ],
        relationships: [
          {
            relationshipKey: 'yan-xiu-neighbor',
            fromCharacterKey: 'yan-shan',
            toCharacterKey: 'xiu-lan',
            type: '乡邻',
            dynamic: '渡口互相帮衬',
          },
        ],
        worldRules: [
          '水灯用油纸与竹篾扎成',
          '野祭不立庙碑',
          '鸡鸣前要收回所有灯',
          '江上雾大会遮对岸',
        ],
        mustInclude: ['油纸水灯', '竹篾', '一盏具体的灯名', '方言或旧称'],
        mustAvoid: ['现代白话套话', '官方普通话报告腔', '直说鬼怪存在'],
      },
      sceneBrief: {
        sceneGoal: '以具体物件承载年代与地方质感，沿点灯、数灯、捞灯、候鸡鸣的旧例逐步推进',
        participants: ['严三', '秀兰'],
        location: '雾江渡口与河滩',
        entryState: [
          '民国二十三年七月十四，江边摆满水灯',
          '严三照旧在渡口守夜，竹篙横在膝上',
          '秀兰在河滩上点灯，数到一百零七盏',
          '雾从江心漫上来，对岸已经看不见',
          '按旧例，鸡鸣前要收回所有灯',
        ],
        exitState: [
          '严三捞起那盏没有名字的水灯',
          '灯内只有半截没烧尽的竹篾',
          '秀兰把灯油倒回江里',
          '鸡叫头遍，雾散了一半',
        ],
        conflict:
          '严三发现多出的第一百零八盏灯没有名帖，捞起来怕替人应了野祭，不捞又怕天亮后被当作他的灯；旧例只教他守到鸡鸣，没教他怎么处置无名灯。',
        requiredFacts: [
          '油纸水灯',
          '竹篾',
          '一百零七盏灯',
          '无名灯是第一百零八盏',
          '灯内没有名帖',
          '雾从江心漫上来',
          '鸡叫头遍',
        ],
        forbiddenFacts: [
          '明确解释鬼怪来源',
          '现代新闻腔',
          '手机、手电筒等现代物件',
          '灯上出现名字',
        ],
        targetLength: { minCodePoints: 850, maxCodePoints: 1450 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-water-lamp',
          phrase: '水灯',
          minOccurrences: 1,
        },
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-oil-paper',
          phrase: '油纸',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-modern-object',
          phrase: '手机',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 850,
          maxCodePoints: 1450,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-period-voice',
          title: '语言是否有年代与地方质感',
          rubric:
            '是否出现现代白话套话、普通话报告腔或现代物件；年代感是否靠油纸、竹篾等具体物件承载。',
        },
      ],
      candidates: [gq2PlaceholderCandidate('folk-night-rite')],
    },
    {
      caseId: 'duel-on-ice',
      title: '野冰内道',
      description: '动作对决第三人称限知混合时态：身体动作与时序必须清楚，不许用模糊拐杖词。',
      contract: {
        premise:
          '两名同门短道速滑手在停训后的野冰场上做最后一次非正式对决，谁先让出内道谁就退出选拔。',
        genre: ['动作', '竞技'],
        tone: ['紧绷', '克制', '利落'],
        themes: ['同门竞争', '内道', '最后的公平'],
        targetAudience: '成人向网文读者',
        narrativePov: 'THIRD_LIMITED',
        tense: 'MIXED',
        protagonist: {
          characterKey: 'chi-jing',
          name: '迟竞',
          role: '短道速滑手',
          motivation: '赢下内道，也逼对手全力一次',
          arc: '从求胜到承认对手',
          traits: ['好胜', '克制', '爆发力强'],
        },
        supportingCharacters: [
          {
            characterKey: 'duan-ge',
            name: '段戈',
            role: '同门对手',
            relationship: '同门竞争对手',
          },
        ],
        relationships: [
          {
            relationshipKey: 'chi-duan-rivalry',
            fromCharacterKey: 'chi-jing',
            toCharacterKey: 'duan-ge',
            type: '同门对手',
            dynamic: '互相较劲又彼此默契',
          },
        ],
        worldRules: [
          '野冰场在旧河道上',
          '冰刀触冰有声',
          '弯道处冰面有暗裂',
          '先让出内道者退出选拔',
        ],
        mustInclude: ['连续三个身体动作', '冰刀与冰面的声音', '明确先后顺序'],
        mustAvoid: ['模糊拐杖词', '动作结果一笔带过', '慢镜头式抽象形容'],
      },
      sceneBrief: {
        sceneGoal: '动作调度与时序清楚，每个身体动作有先后与后果，三圈竞争有完整节拍',
        participants: ['迟竞', '段戈'],
        location: '旧河道野冰场',
        entryState: [
          '两人停训后各自从宿舍后门出来，一前一后到旧河道',
          '各自系好冰刀，迟竞把鞋带多绕一圈',
          '约定三圈定胜负，先让出内道者退出选拔',
          '河道弯道处有一条暗裂，被薄雪盖着',
          '没有裁判，两人只凭冰刀声算圈',
        ],
        exitState: [
          '迟竞在最后一圈让出内道',
          '段戈冲过终点后摔倒',
          '两人躺在冰上，冰刀都朝外',
          '没有人数圈，只听见风从河道北头灌过来',
        ],
        conflict:
          '迟竞想逼段戈全力，也知道段戈只认内道公平；三圈里谁先抢到弯道，谁就拿到先手，但暗裂和旧伤都可能在最后一圈翻盘。',
        requiredFacts: [
          '起跑',
          '第一圈的内道争夺',
          '弯道暗裂',
          '一次摔倒',
          '终圈迟竞让出内道',
          '段戈冲过终点',
          '两人躺在冰上',
        ],
        forbiddenFacts: [
          '“不知怎么”这类模糊衔接',
          '“然后”连续堆叠',
          '用抽象形容替代具体动作',
          '迟竞在最后一圈反超',
        ],
        targetLength: { minCodePoints: 850, maxCodePoints: 1500 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-skate-blade',
          phrase: '冰刀',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-vague-link',
          phrase: '不知怎么',
        },
        {
          kind: 'phrase-max-count',
          constraintId: 'constraint.max-then',
          phrase: '然后',
          maxOccurrences: 1,
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 850,
          maxCodePoints: 1500,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-action-order',
          title: '身体动作时序是否清楚',
          rubric: '每个身体动作是否有明确的先后与后果；是否用模糊拐杖词或抽象形容糊过关键动作。',
        },
      ],
      candidates: [gq2PlaceholderCandidate('duel-on-ice')],
    },
    {
      caseId: 'letters-unsent',
      title: '旧字典里的信',
      description:
        '现代情感第二人称过去时：高情绪浓度下必须用具体细节承载，禁止直陈情绪与结尾升华。',
      contract: {
        premise:
          '你搬离两人同住的旧公寓后，在夜里把没寄出的信一封封重读，写的却始终只是那些不会改变的小事。',
        genre: ['现代情感', '书信体'],
        tone: ['浓烈', '内敛', '拒绝升华'],
        themes: ['失去', '未寄出的信', '日常的不可逆'],
        targetAudience: '成人向网文读者',
        narrativePov: 'SECOND',
        tense: 'PAST',
        protagonist: {
          characterKey: 'letter-you',
          name: '你',
          role: '收信人',
          motivation: '在旧信里找到一句没说出口的话',
          arc: '从回避到承认',
          traits: ['隐忍', '怕告别', '念旧'],
        },
        supportingCharacters: [
          {
            characterKey: 'zhao-yin',
            name: '赵因',
            role: '写信人',
            relationship: '已经离开的同居者',
          },
        ],
        relationships: [
          {
            relationshipKey: 'zhao-you-partnership',
            fromCharacterKey: 'zhao-yin',
            toCharacterKey: 'letter-you',
            type: '同居恋人',
            dynamic: '已分开但旧物未清',
          },
        ],
        worldRules: [
          '信都藏在旧字典里',
          '公寓水槽龙头会滴到第八下停',
          '凌晨一点后没有末班车',
          '旧公寓已经退租',
        ],
        mustInclude: ['一个反复出现的旧物细节', '一件没做完的家务', '信纸的物理细节'],
        mustAvoid: ['直接说出情绪名词', '空泛套话', '结尾强行升华'],
      },
      sceneBrief: {
        sceneGoal: '第二人称以具体细节承载强烈情绪，沿取箱、读信、归位、关灯的完整动线推进',
        participants: ['你', '赵因（不在场）'],
        location: '退租前一晚的旧公寓',
        entryState: [
          '你退租前一晚回来取最后一只纸箱',
          '旧字典从书柜最上层掉下来',
          '一沓未寄出的信从字典里散开',
          '水槽龙头滴到第八下停住',
          '赵因已经先搬走三天',
        ],
        exitState: [
          '你把信按原样夹回字典',
          '纸箱留在门边没有带走',
          '你关灯离开，门锁在身后弹上',
          '没有写回信',
        ],
        conflict:
          '你想把信带走，又怕带走就承认自己还在等；你想把信扔掉，可每封都只写不会改变的小事。最后你发现真正没做完的不是搬家，而是那句始终没写出来的回信。',
        requiredFacts: [
          '旧字典从书柜上层掉下来',
          '一沓未寄出的信',
          '龙头滴到第八下停住',
          '信纸边角发脆',
          '你按原样把信夹回字典',
          '关灯动作',
          '门锁弹上',
        ],
        forbiddenFacts: [
          '直接说出“悲伤、痛苦、后悔”等情绪名词',
          '“人生”式感悟',
          '结尾和解或升华',
          '你写下回信',
          '赵因在门边出现',
        ],
        targetLength: { minCodePoints: 850, maxCodePoints: 1400 },
      },
      constraints: [
        {
          kind: 'required-phrase',
          constraintId: 'constraint.req-dictionary',
          phrase: '字典',
          minOccurrences: 1,
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-sadness',
          phrase: '悲伤',
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-pain',
          phrase: '痛苦',
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-regret',
          phrase: '遗憾',
        },
        {
          kind: 'forbidden-phrase',
          constraintId: 'constraint.no-life-lesson',
          phrase: '人生',
        },
        {
          kind: 'text-length-range',
          constraintId: 'constraint.length',
          minCodePoints: 850,
          maxCodePoints: 1400,
        },
        {
          kind: 'manual-criterion',
          constraintId: 'constraint.manual-concrete-emotion',
          title: '情绪是否由具体细节承载',
          rubric:
            '是否直接使用情绪名词、空泛套话或结尾强行升华；情绪是否附着在旧物、信纸与动作上。',
        },
      ],
      candidates: [gq2PlaceholderCandidate('letters-unsent')],
    },
  ],
});
