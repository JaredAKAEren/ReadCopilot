// 消息模板工具
import {customModelString, defaultOption, services} from "./option";
import {config} from "@/entrypoints/utils/config";
import { TranslateMessage } from "./messageTypes";
import { WORD_SYSTEM_PROMPT, buildWordUserPrompt } from "./wordPrompt";

// openai 格式的消息模板（通用模板）
export function commonMsgTemplate(message: TranslateMessage) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    if (message.mode === 'word') {
        return JSON.stringify({
            'model': model,
            'temperature': 0.3,
            'messages': [
                {'role': 'system', 'content': WORD_SYSTEM_PROMPT},
                {'role': 'user', 'content': buildWordUserPrompt(message.origin, message.sentence ?? '')},
            ]
        })
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        'model': model,
        "temperature": 1.0,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    })
}

// deepseek
export function deepseekMsgTemplate(message: TranslateMessage) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    model = model.replace(/（.*）/g, "");

    if (message.mode === 'word') {
        const payload: any = {
            'model': model,
            'messages': [
                {'role': 'system', 'content': WORD_SYSTEM_PROMPT},
                {'role': 'user', 'content': buildWordUserPrompt(message.origin, message.sentence ?? '')},
            ]
        };
        if (model !== 'deepseek-reasoner') payload.temperature = 0.3;
        return JSON.stringify(payload);
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    const payload: any = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system},
            {'role': 'user', 'content': user},
        ]
    };

    if (model !== 'deepseek-reasoner') {
        payload.temperature = 0.7;
    }

    return JSON.stringify(payload);
}

// gemini
export function geminiMsgTemplate(message: TranslateMessage) {
    if (message.mode === 'word') {
        const userPrompt = `${WORD_SYSTEM_PROMPT}\n\n${buildWordUserPrompt(message.origin, message.sentence ?? '')}`;
        return JSON.stringify({
            "contents": [
                {"role": "user", "parts": [{"text": userPrompt}]},
            ],
            "generationConfig": {
                "responseMimeType": "application/json",
                "temperature": 0.3,
            }
        })
    }

    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        "contents": [
            {"role": "user", "parts": [{"text": user}]},
        ]
    })
}

// claude
export function claudeMsgTemplate(message: TranslateMessage) {
    let model = config.model[services.claude];
    if (model === "claude-3-5-haiku") model = "claude-3-5-haiku-20241022";
    else if (model === "claude-3-5-sonnet") model = "claude-3-5-sonnet-20241022";
    else if (model === "claude-3-opus") model = "claude-3-opus-20240229";

    if (message.mode === 'word') {
        return JSON.stringify({
            model: model,
            max_tokens: 4096,
            stream: false,
            temperature: 0.3,
            system: WORD_SYSTEM_PROMPT,
            messages: [
                {role: "user", content: `${buildWordUserPrompt(message.origin, message.sentence ?? '')}\n\nRespond with JSON only.`},
            ]
        })
    }

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', message.origin);

    return JSON.stringify({
        model: model,
        max_tokens: 4096,
        stream: false,
        system: system,
        messages: [
            {role: "user", content: user},
        ]
    })
}

// 通义千问
export function tongyiMsgTemplate(origin: string) {
    let model = config.model[config.service] === customModelString ? config.customModel[config.service] : config.model[config.service]
    const normalTemplate = () => {
        let system = config.system_role[config.service] || defaultOption.system_role;
        let user = (config.user_role[config.service] || defaultOption.user_role)
            .replace('{{to}}', config.to).replace('{{origin}}', origin);

        return JSON.stringify({
            "model": model,
            "enable_thinking": false,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ]
        })
    }
    // 翻译模型qwen-mt-plus和qwen-mt-turbo的格式和通用的不同
    const mtModelTemplate = () => {
        const langMap = [
            {value: "zh-Hans", target: "zh"},
            {value: "en"},
            {value: "ja"},
            {value: "ko"},
            {value: "fr"},
            {value: "ru"},
        ]
        let targetItem = langMap.find(i => i.value === config.to) || langMap[0]
        let targetLang = targetItem.target || targetItem.value
        return JSON.stringify({
            "model": model,
            "messages": [
                {"role": "user", "content": origin},
            ],
            "translation_options": {
                "source_lang": "auto",
                "target_lang": targetLang
            }
        })
    }
    return model.startsWith("qwen-mt") ? mtModelTemplate() : normalTemplate()

}

// 文心一言
export function yiyanMsgTemplate(origin: string) {
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', origin);

    return JSON.stringify({
        'temperature': 0.7,
        'disable_search': true, // 禁用搜索
        'messages': [
            {"role": "user", "content": user},
        ],
    })
}

export function minimaxTemplate(origin: string) {

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', origin);

    return JSON.stringify({
        model: "MiniMax-Text-01",
        stream: false,
        temperature: 0.7,
        messages: [
            {role: 'system', content: system},
            {role: 'user', content: user},
        ]
    })
}

export function cozeTemplate(origin: string) {

    let system = config.system_role[config.service] || defaultOption.system_role;
    let user = (config.user_role[config.service] || defaultOption.user_role)
        .replace('{{to}}', config.to).replace('{{origin}}', origin);

    return JSON.stringify({
        bot_id: config.robot_id[config.service],
        user: "FluentRead",
        query: system + user,
        stream: false
    });
}
