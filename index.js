import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { GoogleGenAI } from '@google/genai';
import { getVeedService, initVeedService } from './veed-service.js';
import { getVeedQueue, OperationStatus } from './veed-queue.js';

// Global error handlers to prevent server from crashing
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

const app = express();
app.use(cors());
app.use(express.json());

// Serve static files from public directory (for downloaded videos)
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
app.use('/videos', express.static(path.join(__dirname, '../public/videos')));

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const OPENSEA_BEARER_TOKEN = process.env.OPENSEA_BEARER_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;

// Initialize Google GenAI client for Veo
const googleAI = GOOGLE_API_KEY ? new GoogleGenAI({ apiKey: GOOGLE_API_KEY }) : null;

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: ANTHROPIC_API_KEY,
});

// Create OpenSea MCP client
async function createOpenSeaMCPClient() {
  const transport = new SSEClientTransport(
    new URL('https://mcp.opensea.io/sse'),
    {
      requestInit: {
        headers: {
          'Authorization': `Bearer ${OPENSEA_BEARER_TOKEN}`,
        },
      },
    }
  );

  const client = new Client({
    name: 'mute-app',
    version: '1.0.0',
  });

  await client.connect(transport);
  return client;
}

// Convert MCP tools to Claude tool format
function mcpToolsToClaudeTools(mcpTools) {
  return mcpTools.map(tool => ({
    name: tool.name,
    description: tool.description || '',
    input_schema: tool.inputSchema || { type: 'object', properties: {} },
  }));
}

// Chat endpoint
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, useOpenSeaMCP = true, topCollections = false } = req.body;

    let mcpClient = null;
    let tools = [];
    let mcpTools = [];

    // Connect to OpenSea MCP if enabled
    if (useOpenSeaMCP && OPENSEA_BEARER_TOKEN) {
      try {
        mcpClient = await createOpenSeaMCPClient();
        const toolsResult = await mcpClient.listTools();
        mcpTools = toolsResult.tools || [];
        tools = mcpToolsToClaudeTools(mcpTools);
        console.log(`Loaded ${tools.length} OpenSea MCP tools`);
      } catch (mcpError) {
        console.error('Failed to connect to OpenSea MCP:', mcpError);
        // Continue without MCP tools
      }
    }

    if (topCollections && mcpClient) {
      console.log('Fetching top trending collections directly.');
      try {
        const result = await mcpClient.callTool({
          name: 'get_trending_collections',
          arguments: { timeframe: 'ONE_DAY' },
        });

        const fetchedCollections = [];
        const content = result.content;
        if (Array.isArray(content)) {
          for (const item of content) {
            if (item.type === 'text' && item.text) {
              try {
                const parsed = JSON.parse(item.text);
                if (parsed.trendingCollections && Array.isArray(parsed.trendingCollections)) {
                  for (const col of parsed.trendingCollections) {
                    fetchedCollections.push({
                      identifier: col.slug || col.collectionSlug,
                      name: col.name || col.slug,
                      image_url: col.imageUrl || col.image_url,
                      collection: col.slug || col.collectionSlug,
                      floor_price: col.floorPrice?.native?.unit,
                    });
                  }
                }
              } catch (e) {
                console.log('Parse error for topCollections:', e.message);
              }
            }
          }
        }
        await mcpClient.close();
        return res.json({ success: true, collections: fetchedCollections });
      } catch (error) {
        console.error('Error fetching trending collections directly:', error);
        if (mcpClient) {
          try { await mcpClient.close(); } catch (e) {}
        }
        return res.status(500).json({ success: false, error: error.message });
      }
    }

    // System prompt for Liquid AI Assistant
    const systemPrompt = `You are Liquid, an AI assistant specialized in NFTs, crypto tokens, and creative content generation for the MUTE platform.

CRITICAL - YOU MUST USE TOOLS FOR ANY NFT REQUEST:
When a user asks ANYTHING about NFTs (show, find, search, display, list, explore, collections, etc.), you MUST use the appropriate tool. DO NOT just describe NFTs in text - the UI will display them from the tool results.

AVAILABLE TOOLS AND WHEN TO USE THEM:

1. **search** - AI-powered search (BEST for general queries)
   - Use for: "show me X", "find X NFTs", "display X"
   - Parameter: query (natural language string)
   - Returns: NFTs, collections, and tokens matching the query

2. **search_collections** - Find collections by name
   - Use for: "find collections named X", "what collections have X in the name"
   - Parameter: query (string)
   - Returns: Collection slugs and names (minimal info)

3. **get_collections** - Get detailed collection info WITH sample NFT images
   - Use AFTER search_collections to get images
   - Parameters: slugs (array), includes: ["sample_items", "basic_stats"]
   - Returns: Full collection data with sample NFT images

4. **search_items** - Search individual NFTs
   - Use for: specific NFT searches
   - Parameter: query (string)
   - Returns: Minimal info (id, name, collection) - NO IMAGES

5. **get_items** - Get full NFT details with images
   - Use AFTER search_items to get images
   - Parameters: items (array of {contractAddress, tokenId, chain})
   - Returns: Full NFT data with imageUrl

6. **get_trending_collections** - Get trending/popular collections
   - Use for: "trending", "popular", "hot" collections
   - Parameter: timeframe (ONE_HOUR, ONE_DAY, SEVEN_DAYS, THIRTY_DAYS)

RECOMMENDED WORKFLOWS:
- "Show me Mutant Ape NFTs" → Use search(query: "Mutant Ape NFTs")
- "Find collections with Mutant Ape" → Use search_collections(query: "Mutant Ape"), then get_collections with sample_items
- "What's trending?" → Use get_trending_collections(timeframe: "ONE_DAY")
- "Floor price of BAYC?" → Use get_collections(slugs: ["boredapeyachtclub"], includes: ["basic_stats"])

IMPORTANT: After using tools, give a brief response. NFT images automatically appear in the OpenSea panel. Do NOT list NFTs in text.

Be helpful, concise, and focus on actionable suggestions for creative projects.`;

    // Initial Claude request
    let response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: systemPrompt,
      tools: tools.length > 0 ? tools : undefined,
      messages: messages,
    });

    // Handle tool use in a loop
    let conversationMessages = [...messages];
    let currentResponse = response;
    let fetchedNFTs = []; // Store NFTs fetched via MCP tools

    while (currentResponse.stop_reason === 'tool_use') {
      const toolUseBlocks = currentResponse.content.filter(block => block.type === 'tool_use');

      // Add assistant's response with tool calls to conversation
      conversationMessages.push({
        role: 'assistant',
        content: currentResponse.content,
      });

      // Execute each tool call via MCP
      const toolResults = [];
      for (const toolUse of toolUseBlocks) {
        try {
          console.log(`Calling MCP tool: ${toolUse.name}`, toolUse.input);
          const result = await mcpClient.callTool({
            name: toolUse.name,
            arguments: toolUse.input,
          });

          // Extract NFT/collection data from tool results
          if (result.content && Array.isArray(result.content)) {
            for (const item of result.content) {
              if (item.type === 'text' && item.text) {
                try {
                  const parsed = JSON.parse(item.text);
                  console.log('Parsing MCP result, keys:', Object.keys(parsed));
                  // Log first item sample for debugging
                  if (Array.isArray(parsed) && parsed.length > 0) {
                    console.log('First array item sample:', JSON.stringify(parsed[0]).slice(0, 500));
                  }

                  // Handle search_items response (array of items)
                  if (parsed.results && Array.isArray(parsed.results)) {
                    console.log('Found results array with', parsed.results.length, 'items');
                    for (const nft of parsed.results) {
                      fetchedNFTs.push({
                        identifier: nft.id || nft.identifier || nft.tokenId,
                        name: nft.name || nft.metadata?.name || `#${nft.id}`,
                        image_url: nft.imageUrl || nft.image_url || nft.metadata?.imageUrl,
                        collection: nft.collection?.slug || nft.collectionSlug || nft.collection,
                      });
                    }
                  }

                  // Handle items/NFTs response (direct items array)
                  if (parsed.items || parsed.nfts) {
                    const items = parsed.items || parsed.nfts || [];
                    console.log('Found items/nfts array with', items.length, 'items');
                    for (const nft of items) {
                      fetchedNFTs.push({
                        identifier: nft.id || nft.identifier || nft.tokenId,
                        name: nft.name || nft.metadata?.name || `#${nft.id}`,
                        image_url: nft.imageUrl || nft.image_url || nft.metadata?.imageUrl,
                        collection: nft.collection?.slug || nft.collectionSlug || nft.collection,
                      });
                    }
                  }

                  // Handle collections response (for collection metadata)
                  if (parsed.collections && !parsed.results) {
                    for (const col of parsed.collections) {
                      // Only add if we don't have items already
                      if (fetchedNFTs.length === 0) {
                        fetchedNFTs.push({
                          identifier: col.slug,
                          name: col.name || col.slug,
                          image_url: col.imageUrl,
                          collection: col.slug,
                          floor_price: col.floorPrice?.pricePerItem?.native?.unit,
                          description: col.description?.slice(0, 100),
                        });
                      }
                    }
                  }

                  // Handle trendingCollections response from get_trending_collections
                  if (parsed.trendingCollections && Array.isArray(parsed.trendingCollections)) {
                    console.log('Found trendingCollections with', parsed.trendingCollections.length, 'items');
                    for (const col of parsed.trendingCollections) {
                      fetchedNFTs.push({
                        identifier: col.slug || col.collectionSlug,
                        name: col.name || col.slug,
                        image_url: col.imageUrl || col.image_url,
                        collection: col.slug || col.collectionSlug,
                        floor_price: col.floorPrice?.native?.unit,
                      });
                    }
                  }

                  // Handle AI-powered search response (can be an array at top level)
                  if (parsed.nfts && Array.isArray(parsed.nfts)) {
                    console.log('Found nfts array from search with', parsed.nfts.length, 'items');
                    for (const nft of parsed.nfts) {
                      fetchedNFTs.push({
                        identifier: nft.id || nft.identifier || nft.tokenId,
                        tokenId: nft.tokenId,
                        contractAddress: nft.contractAddress,
                        chain: nft.chain || 'ethereum',
                        name: nft.name || `#${nft.id || nft.tokenId}`,
                        image_url: nft.imageUrl || nft.image_url || nft.thumbnailUrl,
                        collection: nft.collection?.slug || nft.collectionSlug || nft.collection,
                      });
                    }
                  }

                  // Handle search results that return as an array at root level
                  if (Array.isArray(parsed)) {
                    console.log('Found root array with', parsed.length, 'items');
                    for (const item of parsed) {
                      // Could be NFT item, collection, or other entity
                      if (item.tokenId || item.contractAddress || item.imageUrl) {
                        // Looks like an NFT
                        fetchedNFTs.push({
                          identifier: item.id || item.identifier || item.tokenId,
                          tokenId: item.tokenId,
                          contractAddress: item.contractAddress,
                          chain: item.chain || 'ethereum',
                          name: item.name || `#${item.id || item.tokenId}`,
                          image_url: item.imageUrl || item.image_url || item.thumbnailUrl,
                          collection: item.collection?.slug || item.collectionSlug || item.collection,
                        });
                      } else if (item.slug) {
                        // Looks like a collection
                        fetchedNFTs.push({
                          identifier: item.slug,
                          name: item.name || item.slug,
                          image_url: item.imageUrl || item.image_url,
                          collection: item.slug,
                        });
                      }
                    }
                  }

                  // Handle search_collections response (collectionsByQuery)
                  if (parsed.collectionsByQuery && Array.isArray(parsed.collectionsByQuery)) {
                    console.log('Found collectionsByQuery with', parsed.collectionsByQuery.length, 'items');
                    for (const col of parsed.collectionsByQuery) {
                      fetchedNFTs.push({
                        identifier: col.slug,
                        name: col.name || col.slug,
                        image_url: col.imageUrl || col.image_url,
                        collection: col.slug,
                      });
                    }
                  }

                  // Handle get_collections with sample_items
                  if (parsed.collections && Array.isArray(parsed.collections)) {
                    for (const col of parsed.collections) {
                      // If collection has sample_items, add those as individual NFTs
                      if (col.sampleItems && Array.isArray(col.sampleItems)) {
                        console.log(`Found ${col.sampleItems.length} sample items for collection ${col.slug}`);
                        for (const item of col.sampleItems) {
                          fetchedNFTs.push({
                            identifier: item.id || item.tokenId,
                            tokenId: item.tokenId,
                            contractAddress: item.contractAddress,
                            chain: item.chain || 'ethereum',
                            name: item.name || `${col.name} #${item.tokenId}`,
                            image_url: item.imageUrl || item.image_url || item.thumbnailUrl,
                            collection: col.slug,
                          });
                        }
                      } else if (fetchedNFTs.length === 0) {
                        // Fallback: add collection image if no sample items
                        fetchedNFTs.push({
                          identifier: col.slug,
                          name: col.name || col.slug,
                          image_url: col.imageUrl,
                          collection: col.slug,
                          floor_price: col.stats?.floorPrice?.native?.unit,
                        });
                      }
                    }
                  }

                  // Handle itemsByQuery response from search_items
                  if (parsed.itemsByQuery && Array.isArray(parsed.itemsByQuery)) {
                    console.log('Found itemsByQuery with', parsed.itemsByQuery.length, 'items');
                    if (parsed.itemsByQuery[0]) {
                      console.log('First item keys:', Object.keys(parsed.itemsByQuery[0]));
                      console.log('First item sample:', JSON.stringify(parsed.itemsByQuery[0]).slice(0, 500));
                    }
                    for (const nft of parsed.itemsByQuery) {
                      // Try multiple possible image field locations
                      const imageUrl = nft.imageUrl || nft.image_url || nft.displayImageUrl ||
                                      nft.display_image_url || nft.thumbnailUrl || nft.thumbnail_url ||
                                      nft.metadata?.imageUrl || nft.metadata?.image || nft.metadata?.image_url;
                      fetchedNFTs.push({
                        identifier: nft.id || nft.identifier || nft.tokenId,
                        tokenId: nft.tokenId,
                        contractAddress: nft.contractAddress,
                        chain: nft.chain?.identifier || 'ethereum',
                        name: nft.name || nft.metadata?.name || `#${nft.id || nft.identifier || nft.tokenId}`,
                        image_url: imageUrl,
                        collection: nft.collection?.slug || nft.collectionSlug || nft.collection,
                      });
                    }
                  }
                } catch (e) {
                  console.log('Parse error:', e.message);
                }
              }
            }
          }

          // Truncate large results to avoid overwhelming the model
          let resultContent = JSON.stringify(result.content);
          if (resultContent.length > 10000) {
            resultContent = resultContent.slice(0, 10000) + '... [truncated]';
          }
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
          });
        } catch (toolError) {
          console.error(`Tool ${toolUse.name} failed:`, toolError);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: JSON.stringify({ error: toolError.message }),
            is_error: true,
          });
        }
      }

      // Add tool results as user message
      conversationMessages.push({
        role: 'user',
        content: toolResults,
      });

      // Continue conversation with tool results
      currentResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        tools: tools,
        messages: conversationMessages,
      });
    }

    console.log(`Fetched ${fetchedNFTs.length} NFTs via MCP tools`);

    // Filter out non-art NFTs (DeFi positions, domains, etc.)
    const originalCount = fetchedNFTs.length;
    fetchedNFTs = fetchedNFTs.filter(nft => !shouldExcludeNFT(nft));
    if (fetchedNFTs.length < originalCount) {
      console.log(`Filtered out ${originalCount - fetchedNFTs.length} non-art NFTs, ${fetchedNFTs.length} remaining`);
    }

    // Enrich NFTs without images by calling get_items
    const nftsNeedingImages = fetchedNFTs.filter(nft => !nft.image_url && nft.contractAddress && nft.tokenId);
    if (nftsNeedingImages.length > 0 && mcpClient) {
      console.log(`Fetching images for ${nftsNeedingImages.length} NFTs...`);
      try {
        // Build items array for get_items
        const items = nftsNeedingImages.slice(0, 20).map(nft => ({
          contractAddress: nft.contractAddress,
          tokenId: nft.tokenId,
          chain: nft.chain || 'ethereum',
        }));
        console.log('Requesting get_items with:', JSON.stringify(items.slice(0, 2)));

        const itemsResult = await mcpClient.callTool({
          name: 'get_items',
          arguments: { items },
        });

        if (itemsResult.content && Array.isArray(itemsResult.content)) {
          for (const item of itemsResult.content) {
            if (item.type === 'text' && item.text) {
              try {
                const parsed = JSON.parse(item.text);
                const items = parsed.items || [];
                console.log(`Got detailed info for ${items.length} items`);

                // Update fetchedNFTs with image URLs
                for (const itemDetail of items) {
                  const matchingNft = fetchedNFTs.find(
                    n => n.tokenId === itemDetail.tokenId && n.contractAddress === itemDetail.contractAddress
                  );
                  if (matchingNft && itemDetail.imageUrl) {
                    matchingNft.image_url = itemDetail.imageUrl;
                  }
                }
              } catch (e) {
                console.log('Error parsing get_items result:', e.message);
              }
            }
          }
        }
      } catch (e) {
        console.log('Error fetching item details:', e.message);
      }
    }

    // Close MCP client
    if (mcpClient) {
      await mcpClient.close();
    }

    // Extract text response
    let textContent = currentResponse.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n');

    // Check if tools were used (conversation grew beyond original messages)
    const toolsWereUsed = conversationMessages.length > messages.length;

    // Parse actions from the response
    const actions = [];
    const actionRegex = /\[ACTION:(\w+):([^\]:]+):?(\d+)?\]/g;
    let match;
    while ((match = actionRegex.exec(textContent)) !== null) {
      actions.push({
        type: match[1],
        param1: match[2],
        param2: match[3] ? parseInt(match[3]) : null,
      });
    }

    // Remove action blocks from displayed message
    textContent = textContent.replace(/\[ACTION:[^\]]+\]/g, '').trim();

    console.log('Chat response - actions:', actions, 'fetchedNFTs:', fetchedNFTs.length);

    res.json({
      success: true,
      message: textContent,
      toolsUsed: toolsWereUsed,
      actions: actions,
      nfts: fetchedNFTs, // NFTs fetched via MCP tools
      fullResponse: currentResponse,
    });

  } catch (error) {
    console.error('Chat API error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasAnthropicKey: !!ANTHROPIC_API_KEY,
    hasOpenSeaToken: !!OPENSEA_BEARER_TOKEN,
  });
});

// Popular PFP collections
const POPULAR_COLLECTIONS = ['pudgypenguins', 'boredapeyachtclub', 'azuki', 'doodles-official', 'cryptopunks', 'milady', 'degods'];

// Collections to filter out (not art/PFP - e.g. DeFi positions, domains, etc.)
const EXCLUDED_COLLECTIONS = [
  'uniswap-v3-positions',
  'uniswap-v4-positions',
  'ens',
  'unstoppable-domains',
  'lido',
  'aave',
  'compound',
  'maker',
  'wrapped',
  'curve',
  'sushiswap',
  'balancer',
];

// Check if an NFT should be filtered out
function shouldExcludeNFT(nft) {
  const collection = (nft.collection || nft.collectionSlug || '').toLowerCase();
  const name = (nft.name || '').toLowerCase();

  // Check against excluded collections
  for (const excluded of EXCLUDED_COLLECTIONS) {
    if (collection.includes(excluded)) return true;
  }

  // Filter out NFTs that look like DeFi positions based on name
  if (name.includes('uniswap')) return true;
  if (name.includes('position') && (name.includes('v3') || name.includes('v4'))) return true;
  if (name.includes('liquidity') && name.includes('pool')) return true;

  // NOTE: Don't filter by missing image - the image URL might be in a different field
  // that we haven't parsed yet, or might be fetched separately

  return false;
}

// Proxy endpoint for OpenSea NFTs - uses MCP tools to get actual NFT items
app.get('/api/opensea/collection/:slug/nfts', async (req, res) => {
  let mcpClient = null;
  try {
    const { slug } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    // Connect to OpenSea MCP
    mcpClient = await createOpenSeaMCPClient();

    // Use get_collections with sample_items to get actual NFT images
    const result = await mcpClient.callTool({
      name: 'get_collections',
      arguments: {
        slugs: [slug],
        includes: ['sample_items', 'basic_stats'],
      },
    });

    console.log('MCP get_collections (with sample_items) for:', slug);

    let nfts = [];

    // Parse the result
    const content = result.content;
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === 'text' && item.text) {
          try {
            const parsed = JSON.parse(item.text);

            // Handle collections array with sample_items
            const collections = parsed.collections || [];
            for (const col of collections) {
              // Add sample items as individual NFTs
              if (col.sampleItems && Array.isArray(col.sampleItems)) {
                console.log(`Found ${col.sampleItems.length} sample items for ${col.slug}`);
                for (const nft of col.sampleItems.slice(0, limit)) {
                  nfts.push({
                    identifier: nft.tokenId || nft.id,
                    tokenId: nft.tokenId,
                    contractAddress: nft.contractAddress,
                    name: nft.name || `${col.name} #${nft.tokenId}`,
                    image_url: nft.imageUrl || nft.image_url || nft.thumbnailUrl,
                    display_image_url: nft.imageUrl || nft.image_url,
                    collection: col.slug,
                    chain: nft.chain || 'ethereum',
                  });
                }
              }
              // If no sample items, use collection image as fallback
              if (nfts.length === 0 && col.imageUrl) {
                nfts.push({
                  identifier: col.slug,
                  name: col.name || col.slug,
                  image_url: col.imageUrl,
                  display_image_url: col.imageUrl,
                  collection: col.slug,
                  floor_price: col.stats?.floorPrice?.native?.unit,
                });
              }
            }
          } catch (e) {
            console.log('Parse error:', e.message);
          }
        }
      }
    }

    await mcpClient.close();

    console.log(`Returning ${nfts.length} NFTs for collection ${slug}`);
    res.json({ nfts });
  } catch (error) {
    console.error('OpenSea MCP proxy error:', error);
    if (mcpClient) {
      try { await mcpClient.close(); } catch (e) {}
    }
    res.status(500).json({ error: error.message });
  }
});

// Get available OpenSea MCP tools
app.get('/api/tools', async (req, res) => {
  try {
    if (!OPENSEA_BEARER_TOKEN) {
      return res.json({ tools: [], message: 'OpenSea token not configured' });
    }

    const mcpClient = await createOpenSeaMCPClient();
    const toolsResult = await mcpClient.listTools();
    await mcpClient.close();

    res.json({
      tools: toolsResult.tools || [],
      count: toolsResult.tools?.length || 0,
    });
  } catch (error) {
    console.error('Failed to get tools:', error);
    res.status(500).json({ error: error.message });
  }
});

// Store pending Veo operations
const veoOperations = new Map();

// Veo video generation endpoint
app.post('/api/veo/generate', async (req, res) => {
  try {
    if (!googleAI) {
      return res.status(400).json({
        success: false,
        error: 'Google API key not configured. Add GOOGLE_API_KEY to .env'
      });
    }

    const { prompt, referenceImage, model = 'veo-2.0-generate-001' } = req.body;

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'Prompt is required' });
    }

    console.log(`Starting Veo generation with model: ${model}`);
    console.log(`Prompt: ${prompt}`);

    // Start video generation
    const generateConfig = {
      model: model,
      prompt: prompt,
    };

    // Add reference image if provided (image-to-video)
    if (referenceImage) {
      generateConfig.image = {
        imageUri: referenceImage,
      };
    }

    const operation = await googleAI.models.generateVideos(generateConfig);

    // Store operation for polling
    const operationId = operation.name || `op_${Date.now()}`;
    veoOperations.set(operationId, {
      operation,
      status: 'processing',
      createdAt: Date.now(),
    });

    console.log(`Veo operation started: ${operationId}`);

    res.json({
      success: true,
      operationId: operationId,
      status: 'processing',
      message: 'Video generation started. Poll /api/veo/status/:operationId for results.',
    });

  } catch (error) {
    console.error('Veo generation error:', error);

    // Extract error message from various error formats (Google API can nest errors)
    let errorMessage = 'Video generation failed';
    if (error.message) {
      errorMessage = error.message;
    }
    if (error.error?.message) {
      errorMessage = error.error.message;
    }
    if (error.response?.data?.error?.message) {
      errorMessage = error.response.data.error.message;
    }

    res.status(500).json({
      success: false,
      error: errorMessage
    });
  }
});

// Check Veo operation status
app.get('/api/veo/status/:operationId', async (req, res) => {
  try {
    if (!googleAI) {
      return res.status(400).json({
        success: false,
        error: 'Google API key not configured'
      });
    }

    const { operationId } = req.params;
    const stored = veoOperations.get(operationId);

    if (!stored) {
      return res.status(404).json({
        success: false,
        error: 'Operation not found'
      });
    }

    // Poll the operation
    const operation = await googleAI.operations.getVideosOperation(stored.operation);

    if (operation.done) {
      // Video is ready
      const videos = operation.response?.generatedVideos || [];
      const videoUrl = videos[0]?.video?.uri || null;

      // Clean up stored operation
      veoOperations.delete(operationId);

      console.log(`Veo operation ${operationId} completed. Video URL: ${videoUrl}`);

      res.json({
        success: true,
        status: 'completed',
        videoUrl: videoUrl,
        videos: videos,
      });
    } else {
      res.json({
        success: true,
        status: 'processing',
        message: 'Video is still being generated...',
      });
    }

  } catch (error) {
    console.error('Veo status check error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Veo health check
app.get('/api/veo/health', (req, res) => {
  res.json({
    available: !!googleAI,
    hasApiKey: !!GOOGLE_API_KEY,
    pendingOperations: veoOperations.size,
  });
});

// ============= VEED.io API Endpoints (with Queue Support) =============

// Veed health check
app.get('/api/veed/health', async (req, res) => {
  try {
    const queue = getVeedQueue();
    const health = await queue.getHealth();
    res.json(health);
  } catch (error) {
    res.json({
      available: false,
      authenticated: false,
      browserConnected: false,
      initializing: false,
      error: error.message,
    });
  }
});

// Initialize Veed service manually
app.post('/api/veed/init', async (req, res) => {
  try {
    const queue = getVeedQueue();
    const ready = await queue.initializeService();

    res.json({
      success: ready,
      message: ready ? 'Veed service initialized' : 'Failed to initialize',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Generate video from image using Veed.io (queue-based, returns immediately with operationId)
app.post('/api/veed/generate', async (req, res) => {
  try {
    const { imageUrl, prompt, aspectRatio, duration } = req.body;

    if (!imageUrl) {
      return res.status(400).json({ success: false, error: 'imageUrl is required' });
    }

    if (!prompt) {
      return res.status(400).json({ success: false, error: 'prompt is required' });
    }

    const queue = getVeedQueue();

    // Enqueue the request - returns immediately
    const queueResult = await queue.enqueue(imageUrl, prompt, { aspectRatio, duration });

    res.json({
      success: true,
      queued: true,
      operationId: queueResult.operationId,
      status: queueResult.status,
      position: queueResult.position,
      queueLength: queueResult.queueLength,
      message: `Request queued. Poll /api/veed/status/${queueResult.operationId} for updates.`,
    });

  } catch (error) {
    console.error('Veed generate error:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get status of a specific operation
app.get('/api/veed/status/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;
    const queue = getVeedQueue();
    const status = queue.getStatus(operationId);

    if (!status) {
      return res.status(404).json({
        success: false,
        error: 'Operation not found',
      });
    }

    // If completed, include the video URL
    let response = {
      success: true,
      ...status,
    };

    if (status.status === OperationStatus.COMPLETED && status.result) {
      // Return relative path - frontend should construct full URL based on API origin
      response.videoUrl = status.result.localPath || status.result.videoUrl;
      response.cdnUrl = status.result.videoUrl;
    }

    res.json(response);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get queue status (all operations)
app.get('/api/veed/queue', async (req, res) => {
  try {
    const queue = getVeedQueue();
    const status = queue.getAllStatus();

    res.json({
      success: true,
      ...status,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Cancel a queued operation
app.delete('/api/veed/cancel/:operationId', async (req, res) => {
  try {
    const { operationId } = req.params;
    const queue = getVeedQueue();
    const result = queue.cancel(operationId);

    if (!result.success) {
      return res.status(400).json({
        success: false,
        error: result.error,
      });
    }

    res.json({
      success: true,
      message: 'Operation cancelled',
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// ============= Audius API Endpoints =============

const AUDIUS_API_KEY = process.env.AUDIUS_API_KEY;
const AUDIUS_BASE_URL = 'https://api.audius.co/v1';

// Get trending tracks
app.get('/api/audius/trending', async (req, res) => {
  try {
    const { genre, time = 'week', limit = 10 } = req.query;
    const params = new URLSearchParams({
      app_name: 'MUTE',
      limit: limit.toString(),
      time,
    });
    if (genre) params.append('genre', genre);
    if (AUDIUS_API_KEY) params.append('api_key', AUDIUS_API_KEY);

    const response = await fetch(`${AUDIUS_BASE_URL}/tracks/trending?${params}`);
    const data = await response.json();

    if (data.data) {
      const tracks = data.data.map(track => {
        // Handle artwork - can be object with sizes or direct URL
        let artworkUrl = null;
        if (track.artwork) {
          if (typeof track.artwork === 'string') {
            artworkUrl = track.artwork;
          } else {
            artworkUrl = track.artwork['480x480'] || track.artwork['150x150'] || track.artwork['1000x1000'];
          }
        }
        // Fallback to cover_art if artwork is not available
        if (!artworkUrl && track.cover_art_sizes) {
          artworkUrl = track.cover_art_sizes['480x480'] || track.cover_art_sizes['150x150'];
        }

        return {
          id: track.id,
          title: track.title,
          artist: track.user?.name || 'Unknown Artist',
          artistHandle: track.user?.handle,
          duration: track.duration,
          artwork: artworkUrl,
          genre: track.genre,
          mood: track.mood,
          playCount: track.play_count,
          streamUrl: `${AUDIUS_BASE_URL}/tracks/${track.id}/stream?app_name=MUTE`,
        };
      });
      console.log('Audius trending - first track artwork:', tracks[0]?.artwork);
      res.json({ success: true, tracks });
    } else {
      res.json({ success: false, error: 'No data returned' });
    }
  } catch (error) {
    console.error('Audius trending error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Search tracks
app.get('/api/audius/search', async (req, res) => {
  try {
    const { q, genre, mood, limit = 10 } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: 'Query parameter "q" is required' });
    }

    const params = new URLSearchParams({
      app_name: 'MUTE',
      query: q,
      limit: limit.toString(),
    });
    if (genre) params.append('genre', genre);
    if (mood) params.append('mood', mood);
    if (AUDIUS_API_KEY) params.append('api_key', AUDIUS_API_KEY);

    const response = await fetch(`${AUDIUS_BASE_URL}/tracks/search?${params}`);
    const data = await response.json();

    if (data.data) {
      const tracks = data.data.map(track => {
        // Handle artwork - can be object with sizes or direct URL
        let artworkUrl = null;
        if (track.artwork) {
          if (typeof track.artwork === 'string') {
            artworkUrl = track.artwork;
          } else {
            artworkUrl = track.artwork['480x480'] || track.artwork['150x150'] || track.artwork['1000x1000'];
          }
        }
        // Fallback to cover_art if artwork is not available
        if (!artworkUrl && track.cover_art_sizes) {
          artworkUrl = track.cover_art_sizes['480x480'] || track.cover_art_sizes['150x150'];
        }

        return {
          id: track.id,
          title: track.title,
          artist: track.user?.name || 'Unknown Artist',
          artistHandle: track.user?.handle,
          duration: track.duration,
          artwork: artworkUrl,
          genre: track.genre,
          mood: track.mood,
          playCount: track.play_count,
          streamUrl: `${AUDIUS_BASE_URL}/tracks/${track.id}/stream?app_name=MUTE`,
        };
      });
      res.json({ success: true, tracks });
    } else {
      res.json({ success: false, error: 'No data returned' });
    }
  } catch (error) {
    console.error('Audius search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get track by ID
app.get('/api/audius/track/:trackId', async (req, res) => {
  try {
    const { trackId } = req.params;
    const params = new URLSearchParams({ app_name: 'MUTE' });
    if (AUDIUS_API_KEY) params.append('api_key', AUDIUS_API_KEY);

    const response = await fetch(`${AUDIUS_BASE_URL}/tracks/${trackId}?${params}`);
    const data = await response.json();

    if (data.data) {
      const track = data.data;

      // Handle artwork - can be object with sizes or direct URL
      let artworkUrl = null;
      if (track.artwork) {
        if (typeof track.artwork === 'string') {
          artworkUrl = track.artwork;
        } else {
          artworkUrl = track.artwork['480x480'] || track.artwork['150x150'] || track.artwork['1000x1000'];
        }
      }
      if (!artworkUrl && track.cover_art_sizes) {
        artworkUrl = track.cover_art_sizes['480x480'] || track.cover_art_sizes['150x150'];
      }

      res.json({
        success: true,
        track: {
          id: track.id,
          title: track.title,
          artist: track.user?.name || 'Unknown Artist',
          artistHandle: track.user?.handle,
          duration: track.duration,
          artwork: artworkUrl,
          genre: track.genre,
          mood: track.mood,
          playCount: track.play_count,
          streamUrl: `${AUDIUS_BASE_URL}/tracks/${track.id}/stream?app_name=MUTE`,
        },
      });
    } else {
      res.status(404).json({ success: false, error: 'Track not found' });
    }
  } catch (error) {
    console.error('Audius track error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Audius health check
app.get('/api/audius/health', (req, res) => {
  res.json({
    available: true,
    hasApiKey: !!AUDIUS_API_KEY,
    baseUrl: AUDIUS_BASE_URL,
  });
});

const PORT = process.env.PORT || process.env.API_PORT || 3001;
const HOST = process.env.API_HOST || 'localhost';

const server = app.listen(PORT, () => {
  console.log(`API server running on http://${HOST}:${PORT}`);
  console.log(`Anthropic API: ${ANTHROPIC_API_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`OpenSea MCP: ${OPENSEA_BEARER_TOKEN ? 'configured' : 'NOT SET'}`);
  console.log(`Google Veo API: ${GOOGLE_API_KEY ? 'configured' : 'NOT SET'}`);
  console.log(`Veed.io: available (POST /api/veed/init to initialize)`);
});

server.on('error', (err) => {
  console.error('Server error:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use`);
  }
});

// Keep the process alive
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  server.close(() => {
    process.exit(0);
  });
});

process.on('exit', (code) => {
  console.log(`Process exiting with code: ${code}`);
});
