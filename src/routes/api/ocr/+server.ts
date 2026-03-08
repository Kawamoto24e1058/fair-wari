import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GEMINI_API_KEY } from '$env/static/private';

export const POST: RequestHandler = async ({ request }) => {
    try {
        const { image } = await request.json();

        if (!image) {
            return json({ error: '画像データがありません' }, { status: 400 });
        }

        if (!GEMINI_API_KEY) {
            return json({ error: 'GEMINI_API_KEY が設定されていません' }, { status: 500 });
        }

        const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
        // 無料枠で利用可能な gemini-2.0-flash を使用
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });

        // Base64から純粋なデータ部分を抽出
        const base64Data = image.split(',')[1] || image;
        const mimeType = image.split(';')[0]?.split(':')[1] || 'image/jpeg';

        const prompt = "このレシート画像から「最終的な合計金額（税込）」を読み取り、半角数字のみを返してください。カンマ（,）や円マーク（¥）、その他のテキストは一切含めないでください。読み取れない場合やレシートではない場合は 'error' とだけ返してください。";

        const result = await model.generateContent([
            prompt,
            {
                inlineData: {
                    data: base64Data,
                    mimeType: mimeType
                }
            }
        ]);

        const responseText = result.response.text().trim().toLowerCase();

        if (responseText === 'error' || isNaN(Number(responseText.replace(/[^0-9]/g, '')))) {
            return json({ error: 'レシートから合計金額を読み取れませんでした' }, { status: 422 });
        }

        const amount = parseInt(responseText.replace(/[^0-9]/g, ''), 10);

        return json({
            amount: amount,
            message: '解析が完了しました'
        });
    } catch (error: any) {
        console.error('OCR API Error:', error);
        return json({ error: 'Gemini APIによる解析中にエラーが発生しました' }, { status: 500 });
    }
};
