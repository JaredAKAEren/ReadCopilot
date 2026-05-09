import {commonMsgTemplate} from "../utils/template";
import {method} from "../utils/constant";
import {services} from "@/entrypoints/utils/option";
import {config} from "@/entrypoints/utils/config";
import { interpretLLMContent } from "@/entrypoints/utils/wordPrompt";

async function custom(message: any) {

    let headers = new Headers();
    headers.append('Content-Type', 'application/json');
    headers.append('Authorization', `Bearer ${config.token[services.custom]}`);

    const resp = await fetch(config.custom, {
        method: method.POST,
        headers: headers,
        body: commonMsgTemplate(message)
    });

    if (resp.ok) {
        let result = await resp.json();
        return interpretLLMContent(result.choices[0].message.content, message.mode);
    } else {
        console.log("翻译失败：", resp);
        throw new Error(`翻译失败: ${resp.status} ${resp.statusText} body: ${await resp.text()}`);
    }
}

export default custom;