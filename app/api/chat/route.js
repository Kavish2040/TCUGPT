import { NextResponse } from 'next/server';
import OpenAI from 'openai';
import fetch from 'node-fetch';
import { YoutubeTranscript } from 'youtube-transcript';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' }); // Load environment variables from .env.local

const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const GOOGLE_CX = process.env.GOOGLE_CX;
const PINECONE_API_KEY = process.env.PINECONE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;


// Helper function to perform Google search
async function googleSearch(query, searchForRatings = false) {
    let url;
    if (searchForRatings) {
        url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query + ' site:ratemyprofessors.com')}`;
    } else {
        url = `https://www.googleapis.com/customsearch/v1?key=${GOOGLE_API_KEY}&cx=${GOOGLE_CX}&q=${encodeURIComponent(query)}`;
    }

    try {
        const response = await fetch(url);
        console.log(response)

        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
            const data = await response.json();
            console.log(data)
            return data.items ? data.items.map(item => item.snippet).join('\n') : 'No relevant results found.';
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


// Refine user query based on keywords
function refineQuery(userQuery) {
    userQuery = userQuery.trim().toLowerCase();
    let searchForRatings = false;
    const urlRegex = /(https?:\/\/[^\s]+)/g;


    if (userQuery.includes('rating') || userQuery.includes('ratings')) {
        userQuery += ' rate my professor';
        searchForRatings = true;
    } else if (userQuery.includes('calendar') || userQuery.includes('break') || userQuery.includes('p/nc') || userQuery.includes('deadline') || userQuery.includes('holiday')) {
        userQuery += ' TCU academic calendar';
    } else if (userQuery.includes('dorm') || userQuery.includes('housing')) {
        userQuery += ' TCU dorm reviews 2024';
    } else if (!(userQuery.match(urlRegex))){
        userQuery += ' Texas Christian University';
    }
    else if (userQuery.includes('rating') || userQuery.includes('ratings')) {
            userQuery = userQuery.replace("Texas Christian University", " ");
            searchForRatings = true;
        }
    else if (userQuery.includes('book') || userQuery.includes('full book') || userQuery.includes('pdf') || userQuery.includes('book download link')) {
        userQuery = userQuery.replace("Texas Christian University", " ");
        userQuery += 'Amazon or walmart '
        }
    

console.log(userQuery)
    return { refinedQuery: userQuery.replace('?', ''), searchForRatings };
}

// Helper function to get YouTube transcript
async function getYouTubeTranscript(url) {
    const videoId = new URL(url).searchParams.get('v');
    const transcript = await YoutubeTranscript.fetchTranscript(url);
    console.log(transcript)
    return transcript.map(item => item.text).join(' ');
}

export async function POST(req) {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const { messages } = await req.json();

    let userQuery = messages.filter(m => m.role === 'user').reverse()[0]?.content || '';
    let { refinedQuery, searchForRatings } = refineQuery(userQuery);

    // Check if the user query contains a URL
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = userQuery.match(urlRegex);

    if (urls && urls.length > 0) {
        // Extract and use the YouTube transcript as part of the refined query
        const youtubeTranscript = await getYouTubeTranscript(urls[0]);
        refinedQuery += ' ' + 'from this text provided, give an answer directly based on the query from the given text:' + youtubeTranscript;
    }

    if (!refinedQuery) {
        return new NextResponse('No query provided.', { status: 400 });
    }

    const searchResults = await googleSearch(refinedQuery, searchForRatings);



    // Construct a more detailed prompt for the AI
    const chatResponse = await openai.chat.completions.create({
        messages: [
            { role: 'system', content: "You are an expert on Texas Christian University. Provide concise, accurate, and contextually relevant answers based on the search results provided." },
            { role: 'user', content: refinedQuery },
            { role: 'system', content: `Search results:\n${searchResults}` }
        ],
        model: 'gpt-4o-mini',
    });

    const textResponse = chatResponse.choices[0]?.message?.content || 'Error processing your request.';
    return new NextResponse(textResponse, { status: 200, headers: { 'Content-Type': 'application/json' } });
}
