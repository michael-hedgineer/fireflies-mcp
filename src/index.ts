#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
  Tool,
  CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from 'zod';
import axios from 'axios';

// Define tool configurations
const TOOLS: Tool[] = [
  {
    name: "fireflies_get_transcripts",
    description: "Retrieve a list of meeting transcripts with optional filtering",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of transcripts to return (default: 10)"
        },
        from_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD)"
        },
        to_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD)"
        }
      }
    }
  },
  {
    name: "fireflies_get_transcript_details",
    description: "Retrieve detailed information about a specific transcript",
    inputSchema: {
      type: "object",
      properties: {
        transcript_id: {
          type: "string",
          description: "ID of the transcript to retrieve"
        }
      },
      required: ["transcript_id"]
    }
  },
  {
    name: "fireflies_search_transcripts",
    description: "Search for transcripts containing specific keywords",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query to find relevant transcripts"
        },
        limit: {
          type: "number",
          description: "Maximum number of transcripts to return (default: 10)"
        }
      },
      required: ["query"]
    }
  },
  {
    name: "fireflies_generate_summary",
    description: "Generate a summary of a meeting transcript",
    inputSchema: {
      type: "object",
      properties: {
        transcript_id: {
          type: "string",
          description: "ID of the transcript to summarize"
        },
        format: {
          type: "string",
          enum: ["bullet_points", "paragraph"],
          description: "Format of the summary (bullet_points or paragraph)"
        }
      },
      required: ["transcript_id"]
    }
  }
];

class FirefliesApiClient {
  private baseUrl: string;
  private apiKey: string;

  constructor(apiKey: string) {
    this.baseUrl = 'https://api.fireflies.ai/graphql';
    this.apiKey = apiKey;
  }

  private async executeQuery(query: string, variables: Record<string, any> = {}): Promise<any> {
    try {
      const response = await axios.post(
        this.baseUrl,
        { query, variables },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          }
        }
      );

      if (response.data.errors) {
        throw new Error(response.data.errors[0].message);
      }

      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        if (error.response?.status === 401) {
          throw new McpError(ErrorCode.InvalidRequest, 'Invalid API key or unauthorized access');
        } else if (error.response?.status === 404) {
          throw new McpError(ErrorCode.InvalidParams, 'Resource not found');
        } else {
          throw new McpError(
            ErrorCode.InternalError,
            `API request failed: ${error.message}`
          );
        }
      }
      throw new McpError(ErrorCode.InternalError, `Unknown error: ${(error as Error).message}`);
    }
  }

  async getTranscripts(limit?: number, fromDate?: string, toDate?: string): Promise<any[]> {
    const query = `
      query GetTranscripts($limit: Int, $fromDate: Float, $toDate: Float) {
        transcripts(limit: $limit, fromDate: $fromDate, toDate: $toDate) {
          id
          title
          date
          dateString
          duration
          transcript_url
          participants
          speakers {
            id
            name
          }
          summary {
            keywords
            action_items
            overview
          }
        }
      }
    `;

    // Convert date strings to timestamps if provided
    let fromTimestamp: number | undefined;
    let toTimestamp: number | undefined;

    if (fromDate) {
      fromTimestamp = new Date(fromDate).getTime();
    }

    if (toDate) {
      toTimestamp = new Date(toDate).getTime();
    }

    const variables = {
      limit: limit || 10,
      fromDate: fromTimestamp,
      toDate: toTimestamp
    };

    const data = await this.executeQuery(query, variables);
    return data.transcripts;
  }

  async getTranscriptDetails(transcriptId: string): Promise<any> {
    const query = `
      query GetTranscriptDetails($id: String!) {
        transcript(id: $id) {
          id
          title
          date
          dateString
          duration
          transcript_url
          participants
          speakers {
            id
            name
          }
          sentences {
            index
            speaker_name
            text
            raw_text
            start_time
            end_time
          }
          summary {
            keywords
            action_items
            outline
            overview
          }
          meeting_attendees {
            displayName
            email
          }
        }
      }
    `;

    const variables = {
      id: transcriptId
    };

    const data = await this.executeQuery(query, variables);
    return data.transcript;
  }

  async searchTranscripts(searchQuery: string, limit?: number): Promise<any[]> {
    // Fireflies doesn't have a direct search endpoint, so we'll fetch transcripts
    // and filter them by title (this is a simplified approach)
    const query = `
      query GetTranscripts($limit: Int) {
        transcripts(limit: $limit) {
          id
          title
          date
          dateString
          duration
          transcript_url
          participants
          speakers {
            id
            name
          }
          sentences {
            text
          }
          summary {
            keywords
            overview
          }
        }
      }
    `;

    const variables = {
      limit: limit || 20 // Fetch more to filter
    };

    const data = await this.executeQuery(query, variables);
    
    // Simple client-side search (in a real implementation, you'd want a server-side search)
    const searchTermLower = searchQuery.toLowerCase();
    return data.transcripts.filter((transcript: any) => {
      // Search in title
      if (transcript.title.toLowerCase().includes(searchTermLower)) {
        return true;
      }
      
      // Search in sentences
      if (transcript.sentences && transcript.sentences.some((s: any) => 
        s.text.toLowerCase().includes(searchTermLower)
      )) {
        return true;
      }
      
      // Search in keywords
      if (transcript.summary && transcript.summary.keywords && 
          transcript.summary.keywords.some((k: string) => k.toLowerCase().includes(searchTermLower))) {
        return true;
      }
      
      return false;
    }).slice(0, limit || 10);
  }

  async generateTranscriptSummary(transcriptId: string, format: string = 'bullet_points'): Promise<string> {
    // First, get the transcript details
    const transcript = await this.getTranscriptDetails(transcriptId);
    
    // Extract the summary based on the requested format
    if (!transcript.summary) {
      throw new McpError(ErrorCode.InvalidParams, 'Summary not available for this transcript');
    }
    
    if (format === 'bullet_points') {
      // Return bullet point format
      const bullets = [];
      
      if (transcript.summary.overview) {
        bullets.push(`Overview: ${transcript.summary.overview}`);
      }
      
      if (transcript.summary.action_items && transcript.summary.action_items.length > 0) {
        bullets.push('Action Items:');
        transcript.summary.action_items.forEach((item: string) => {
          bullets.push(`- ${item}`);
        });
      }
      
      if (transcript.summary.keywords && transcript.summary.keywords.length > 0) {
        bullets.push(`Keywords: ${transcript.summary.keywords.join(', ')}`);
      }
      
      return bullets.join('\n');
    } else {
      // Return paragraph format
      let summary = '';
      
      if (transcript.summary.overview) {
        summary += transcript.summary.overview + ' ';
      }
      
      if (transcript.summary.action_items && transcript.summary.action_items.length > 0) {
        summary += 'Action items include: ' + transcript.summary.action_items.join('; ') + '. ';
      }
      
      if (transcript.summary.keywords && transcript.summary.keywords.length > 0) {
        summary += 'Key topics discussed: ' + transcript.summary.keywords.join(', ') + '.';
      }
      
      return summary;
    }
  }
}

class FirefliesServer {
  private apiClient: FirefliesApiClient;
  private server: Server;

  constructor() {
    // Check if API key is provided
    const apiKey = process.env.FIREFLIES_API_KEY;
    if (!apiKey) {
      console.error('Error: FIREFLIES_API_KEY environment variable is required');
      process.exit(1);
    }

    this.apiClient = new FirefliesApiClient(apiKey);
    this.server = new Server(
      {
        name: "fireflies-mcp-server",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.setupErrorHandling();
  }

  private setupErrorHandling(): void {
    this.server.onerror = (error) => {
      console.error("[MCP Error]", error);
    };

    process.on('SIGINT', async () => {
      await this.stop();
      process.exit(0);
    });
  }

  private setupHandlers(): void {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOLS
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => 
      this.handleToolCall(request.params.name, request.params.arguments ?? {})
    );
  }

  /**
   * Handles tool call requests
   */
  private async handleToolCall(name: string, args: any): Promise<{ toolResult: CallToolResult }> {
    try {
      switch (name) {
        case "fireflies_get_transcripts": {
          const { limit, from_date, to_date } = args;
          const transcripts = await this.apiClient.getTranscripts(limit, from_date, to_date);
          
          return {
            toolResult: {
              content: [{
                type: "text",
                text: JSON.stringify(transcripts, null, 2)
              }]
            }
          };
        }

        case "fireflies_get_transcript_details": {
          const { transcript_id } = args;
          
          if (!transcript_id) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'transcript_id parameter is required'
            );
          }
          
          const transcript = await this.apiClient.getTranscriptDetails(transcript_id);
          
          return {
            toolResult: {
              content: [{
                type: "text",
                text: JSON.stringify(transcript, null, 2)
              }]
            }
          };
        }

        case "fireflies_search_transcripts": {
          const { query, limit } = args;
          
          if (!query) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'query parameter is required'
            );
          }
          
          const transcripts = await this.apiClient.searchTranscripts(query, limit);
          
          return {
            toolResult: {
              content: [{
                type: "text",
                text: JSON.stringify(transcripts, null, 2)
              }]
            }
          };
        }

        case "fireflies_generate_summary": {
          const { transcript_id, format = 'bullet_points' } = args;
          
          if (!transcript_id) {
            throw new McpError(
              ErrorCode.InvalidParams,
              'transcript_id parameter is required'
            );
          }
          
          const summary = await this.apiClient.generateTranscriptSummary(transcript_id, format);
          
          return {
            toolResult: {
              content: [{
                type: "text",
                text: summary
              }]
            }
          };
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error) {
      if (error instanceof McpError) {
        throw error;
      }
      
      throw new McpError(
        ErrorCode.InternalError,
        `Error processing request: ${(error as Error).message}`
      );
    }
  }

  /**
   * Starts the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.log('Fireflies MCP server is running');
  }

  /**
   * Stops the server
   */
  async stop(): Promise<void> {
    try {
      await this.server.close();
    } catch (error) {
      console.error('Error while stopping server:', error);
    }
  }
}

// Main execution
async function main() {
  const server = new FirefliesServer();
  
  try {
    await server.start();
  } catch (error) {
    console.error("Server failed to start:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
}); 