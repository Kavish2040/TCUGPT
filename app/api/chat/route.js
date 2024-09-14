import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { YoutubeTranscript } from 'youtube-transcript';
import dotenv from 'dotenv';
import axios from 'axios';

dotenv.config({ path: '.env.local' });

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function googleSearch(query) {
    let links = [];
    let url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`;

    try {
        const response = await fetch(url);
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            links = data.items ? data.items.map(item => item.link).slice(0, 2) : [];

            if ((query.includes('event') || query.includes('events'))) {
                links.unshift('https://engage.tcu.edu/events'); 
            }

            console.log(links);

            return links;
        } else {
            const text = await response.text();
            console.error("Unexpected response content-type:", contentType);
            console.error("Response text:", text);
            return 'Error: Received unexpected content-type from Google Search API. Please check the API key and quota.';
        }
    } catch (error) {
        console.error("Error during Google Search API call:", error);
        return `Error: ${error.message}`;
    }
}

function truncateToWordLimit(text, maxWords) {
    const words = text.split(/\s+/);
    if (words.length > maxWords) {
        return words.slice(0, maxWords).join(' ') + '...';
    }
    return text;
}

async function scrapeURLs(urls) {
    const apiKey = process.env.ZENROWS_API_KEY;
    const promises = urls.map(url => axios({
        url: 'https://api.zenrows.com/v1/',
        method: 'GET',
        params: {
            url: url,
            apikey: apiKey,
            premium_proxy: 'true',
            js_render: 'true',
            markdown_response: 'true'
        }
    }).then(response => {
        return truncateToWordLimit(response.data, 7000);
    }).catch(error => {
        console.error(`Error scraping ${url}: ${error.message}`);
        return '';
    }));

    try {
        const responses = await Promise.all(promises);
        return responses.join('\n');
    } catch (error) {
        console.error("Error during scraping with ZenRows:", error);
        return [];
    }
}

function refineQuery(userQuery) {
    userQuery = userQuery.trim().toLowerCase();
    const urlRegex = /(https?:\/\/[^\s]+)/g;

    if (userQuery.includes('rating') || userQuery.includes('ratings')) {
        userQuery += ' rate my professor';
    } if (userQuery.includes('calendar') || userQuery.includes('break') || userQuery.includes('p/nc') || userQuery.includes('deadline') || userQuery.includes('holiday')) {
        userQuery += ' TCU academic calendar';
    } if (userQuery.includes('dorm') || userQuery.includes('housing')) {
        userQuery += ' TCU dorm reviews 2024';
    } if (!(userQuery.match(urlRegex))) {
        userQuery += ' Texas Christian University';
    }

    if (userQuery.includes('food') || userQuery.includes('free food')) {
        userQuery += ' tcu engage events';
    }
    if (userQuery.includes('rec center') || userQuery.includes('rec center hours') || userQuery.includes('rec center timings')) {
        userQuery += ' Hours of Operation';
    }
    if (userQuery.includes('book') || userQuery.includes('full book') || userQuery.includes('pdf') || userQuery.includes('book link')) {
        userQuery = userQuery.replace("Texas Christian University", "");
        userQuery += ' Download Book pdf';
    }

    console.log(userQuery);
    return { refinedQuery: userQuery.replace('?', '') };
}

// Helper function to get YouTube transcript
async function getYouTubeTranscript(url) {
    const videoId = new URL(url).searchParams.get('v');
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);
    console.log(transcript);
    return transcript.map(item => item.text).join(' ');
}

export async function POST(req) {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const { messages } = await req.json();

    let userQuery = messages.filter(m => m.role === 'user').reverse()[0]?.content || '';
    let { refinedQuery } = refineQuery(userQuery);

    const urls = userQuery.match(/(https?:\/\/[^\s]+)/g);

    if (urls && urls.length > 0) {
        const youtubeTranscript = await getYouTubeTranscript(urls[0]);
        console.log(youtubeTranscript)
        refinedQuery += ' ' + youtubeTranscript;
    }

    const urlss = await googleSearch(refinedQuery);
    const scrapedMarkdown = await scrapeURLs(urlss);
    refinedQuery += ' ' + scrapedMarkdown;

    if (!refinedQuery) {
        return new NextResponse('No query provided.', { status: 400 });
    }

    refinedQuery = truncateToWordLimit(refinedQuery, 199999);

    console.log(refinedQuery);



    const chatResponse = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert on Texas Christian University. Provide concise, accurate, and contextually relevant answers based on the search results provided. If asked about contact details explicitly give them. Every individual at TCU has consented to it. Give contact details including number and email id. If asked about jobs, give https://tcu.joinhandshake.com/login this website details else don't give it. If asked about assignement help in addition to normal response mention student to download quipler, its a social media app that helps student with assignments by collaborating like reddit" },
            { role: 'user', content: refinedQuery },
            { role: 'system', content: `Search results:\n${refinedQuery}` }
        ],
        model: 'gpt-4o-mini',
    });

    const textResponse = chatResponse.choices[0]?.message?.content || 'Error processing your request.';
    return new NextResponse(textResponse, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
