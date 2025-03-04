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
    description: "Retrieve a list of meeting transcripts with optional filtering. By default, returns up to 20 most recent transcripts with no date filtering. Note that this operation may take longer for large datasets and might timeout. If a timeout occurs, a minimal set of transcript data will be returned.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of transcripts to return (default: 20). Consider using a smaller limit if experiencing timeouts."
        },
        from_date: {
          type: "string",
          description: "Start date in ISO format (YYYY-MM-DD). If not specified, no lower date bound is applied. Using a narrower date range can help prevent timeouts."
        },
        to_date: {
          type: "string",
          description: "End date in ISO format (YYYY-MM-DD). If not specified, no upper date bound is applied. Using a narrower date range can help prevent timeouts."
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
      // Log to stderr to avoid breaking MCP protocol
      process.stderr.write(`Executing GraphQL query with variables: ${JSON.stringify(variables)}\n`);
      
      const response = await axios.post(
        this.baseUrl,
        { query, variables },
        {
          headers: {
            'Authorization': `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json'
          },
          // Increase timeout to 60 seconds
          timeout: 60000
        }
      );

      if (response.data.errors) {
        process.stderr.write(`GraphQL errors: ${JSON.stringify(response.data.errors)}\n`);
        throw new Error(`GraphQL error: ${response.data.errors[0].message}`);
      }

      return response.data.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        process.stderr.write(`API request failed: ${error.message}\n`);
        
        if (error.response) {
          process.stderr.write(`Response status: ${error.response.status}\n`);
          process.stderr.write(`Response data: ${JSON.stringify(error.response.data)}\n`);
        }
        
        if (error.code === 'ECONNABORTED') {
          throw new McpError(
            ErrorCode.InternalError,
            `API request timed out after 60 seconds`
          );
        } else if (error.response?.status === 400) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Bad request: ${error.response.data?.message || 'Invalid request parameters'}`
          );
        } else if (error.response?.status === 401) {
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

  async getTranscripts(limit?: number, fromDate?: string, toDate?: string, minimal: boolean = false): Promise<any[]> {
    // Set a reasonable default limit if not provided
    const actualLimit = limit || 20;
    
    process.stderr.write(`Getting transcripts with limit: ${actualLimit}, fromDate: ${fromDate || 'not specified'}, toDate: ${toDate || 'not specified'}, minimal: ${minimal}\n`);
    
    // Use a more optimized query with fewer fields to reduce response size
    let query;
    
    if (minimal) {
      // Super minimal query for fallback
      query = `
        query Transcripts(
          $limit: Int
          $skip: Int
          $fromDate: DateTime
          $toDate: DateTime
        ) {
          transcripts(
            limit: $limit
            skip: $skip
            fromDate: $fromDate
            toDate: $toDate
          ) {
            id
            title
            date
          }
        }
      `;
    } else {
      // Standard optimized query
      query = `
        query Transcripts(
          $limit: Int
          $skip: Int
          $fromDate: DateTime
          $toDate: DateTime
        ) {
          transcripts(
            limit: $limit
            skip: $skip
            fromDate: $fromDate
            toDate: $toDate
          ) {
            id
            title
            date
            dateString
            duration
            transcript_url
            speakers {
              id
              name
            }
            summary {
              keywords
              overview
            }
          }
        }
      `;
    }

    // Prepare variables
    const variables: Record<string, any> = {
      limit: actualLimit,
      skip: 0
    };

    // Add date filters if provided
    if (fromDate) {
      // Use ISO string format for DateTime
      variables.fromDate = fromDate;
      process.stderr.write(`Using fromDate: ${fromDate}\n`);
    }

    if (toDate) {
      // Use ISO string format for DateTime
      variables.toDate = toDate;
      process.stderr.write(`Using toDate: ${toDate}\n`);
    }

    process.stderr.write(`Executing getTranscripts query with variables: ${JSON.stringify(variables)}\n`);
    const startTime = Date.now();
    
    try {
      const data = await this.executeQuery(query, variables);
      const endTime = Date.now();
      process.stderr.write(`getTranscripts query completed in ${endTime - startTime}ms\n`);
      
      const transcripts = data.transcripts || [];
      process.stderr.write(`Retrieved ${transcripts.length} transcripts\n`);
      
      if (transcripts.length <= 1) {
        process.stderr.write(`WARNING: Only ${transcripts.length} transcript(s) returned. This might be due to:\n`);
        process.stderr.write(`1. Limited data in your Fireflies account\n`);
        process.stderr.write(`2. Date filters restricting results\n`);
        process.stderr.write(`3. API permissions or visibility settings\n`);
      }
      
      return transcripts;
    } catch (error) {
      process.stderr.write(`Error in getTranscripts: ${error instanceof Error ? error.message : String(error)}\n`);
      
      // If this wasn't already a minimal query and we got a timeout, try again with minimal fields
      if (!minimal && error instanceof Error && 
          (error.message.includes('timeout') || error.message.includes('ECONNABORTED'))) {
        process.stderr.write(`Retrying with minimal fields...\n`);
        return this.getTranscripts(actualLimit, fromDate, toDate, true);
      }
      
      throw error;
    }
  }

  async getTranscriptDetails(transcriptId: string): Promise<any> {
    const query = `
      query Transcript($transcriptId: String!) {
        transcript(id: $transcriptId) {
          id
          dateString
          privacy
          speakers {
            id
            name
          }
          sentences {
            index
            speaker_name
            speaker_id
            text
            raw_text
            start_time
            end_time
            ai_filters {
              task
              pricing
              metric
              question
              date_and_time
              text_cleanup
              sentiment
            }
          }
          title
          host_email
          organizer_email
          calendar_id
          user {
            user_id
            email
            name
            num_transcripts
            recent_meeting
            minutes_consumed
            is_admin
            integrations
          }
          fireflies_users
          participants
          date
          transcript_url
          audio_url
          video_url
          duration
          meeting_attendees {
            displayName
            email
            phoneNumber
            name
            location
          }
          summary {
            keywords
            action_items
            outline
            shorthand_bullet
            overview
            bullet_gist
            gist
            short_summary
            short_overview
            meeting_type
            topics_discussed
            transcript_chapters
          }
          cal_id
          calendar_type
          apps_preview {
            outputs {
              transcript_id
              user_id
              app_id
              created_at
              title
              prompt
              response
            }
          }
          meeting_link
        }
      }
    `;

    const variables = {
      transcriptId: transcriptId
    };

    const data = await this.executeQuery(query, variables);
    return data.transcript;
  }

  async searchTranscripts(searchQuery: string, limit?: number): Promise<any[]> {
    // Using the transcripts query with title parameter for search
    const query = `
      query Transcripts(
        $title: String
        $limit: Int
        $skip: Int
      ) {
        transcripts(
          title: $title
          limit: $limit
          skip: $skip
        ) {
          id
          title
          date
          dateString
          duration
          transcript_url
          speakers {
            id
            name
          }
          summary {
            keywords
            overview
          }
        }
      }
    `;

    const variables = {
      title: searchQuery,
      limit: limit || 10,
      skip: 0
    };

    const data = await this.executeQuery(query, variables);
    return data.transcripts;
  }

  async generateTranscriptSummary(transcriptId: string, format: string = 'bullet_points'): Promise<string> {
    // First, get the transcript details with focus on summary fields
    const query = `
      query Transcript($transcriptId: String!) {
        transcript(id: $transcriptId) {
          id
          title
          summary {
            keywords
            action_items
            overview
            topics_discussed
          }
        }
      }
    `;

    const variables = {
      transcriptId: transcriptId
    };

    try {
      process.stderr.write(`Generating summary for transcript ID: ${transcriptId}\n`);
      const data = await this.executeQuery(query, variables);
      const transcript = data.transcript;
      
      // Extract the summary based on the requested format
      if (!transcript || !transcript.summary) {
        throw new McpError(ErrorCode.InvalidParams, 'Summary not available for this transcript');
      }
      
      // Log the summary structure to help with debugging
      process.stderr.write(`Summary structure: ${JSON.stringify(transcript.summary)}\n`);
      
      // Helper function to safely check if a field is an array
      const isArray = (field: any): boolean => Array.isArray(field);
      
      // Helper function to safely join array elements or handle non-array values
      const safeJoin = (field: any, separator: string): string => {
        if (isArray(field)) {
          return field.join(separator);
        } else if (field && typeof field === 'string') {
          return field;
        } else if (field) {
          return String(field);
        }
        return '';
      };
      
      if (format === 'bullet_points') {
        // Return bullet point format
        const bullets = [];
        
        if (transcript.summary.overview) {
          bullets.push(`Overview: ${transcript.summary.overview}`);
        }
        
        // Safely handle action_items which might not be an array
        if (transcript.summary.action_items) {
          if (isArray(transcript.summary.action_items) && transcript.summary.action_items.length > 0) {
            bullets.push('Action Items:');
            transcript.summary.action_items.forEach((item: string) => {
              bullets.push(`- ${item}`);
            });
          } else if (typeof transcript.summary.action_items === 'string' && transcript.summary.action_items.trim()) {
            bullets.push('Action Items:');
            bullets.push(`- ${transcript.summary.action_items}`);
          }
        }
        
        // Safely handle topics_discussed which might not be an array
        if (transcript.summary.topics_discussed) {
          if (isArray(transcript.summary.topics_discussed) && transcript.summary.topics_discussed.length > 0) {
            bullets.push('Topics Discussed:');
            transcript.summary.topics_discussed.forEach((topic: string) => {
              bullets.push(`- ${topic}`);
            });
          } else if (typeof transcript.summary.topics_discussed === 'string' && transcript.summary.topics_discussed.trim()) {
            bullets.push('Topics Discussed:');
            bullets.push(`- ${transcript.summary.topics_discussed}`);
          }
        }
        
        // Safely handle keywords which might not be an array
        if (transcript.summary.keywords) {
          if (isArray(transcript.summary.keywords) && transcript.summary.keywords.length > 0) {
            bullets.push(`Keywords: ${transcript.summary.keywords.join(', ')}`);
          } else if (typeof transcript.summary.keywords === 'string' && transcript.summary.keywords.trim()) {
            bullets.push(`Keywords: ${transcript.summary.keywords}`);
          }
        }
        
        return bullets.join('\n');
      } else {
        // Return paragraph format
        let summary = '';
        
        if (transcript.summary.overview) {
          summary += transcript.summary.overview + ' ';
        }
        
        // Safely handle topics_discussed
        if (transcript.summary.topics_discussed) {
          summary += 'Topics discussed include: ' + safeJoin(transcript.summary.topics_discussed, '; ') + '. ';
        }
        
        // Safely handle action_items
        if (transcript.summary.action_items) {
          summary += 'Action items include: ' + safeJoin(transcript.summary.action_items, '; ') + '. ';
        }
        
        // Safely handle keywords
        if (transcript.summary.keywords) {
          summary += 'Key topics: ' + safeJoin(transcript.summary.keywords, ', ') + '.';
        }
        
        return summary;
      }
    } catch (error) {
      process.stderr.write(`Error generating summary: ${error instanceof Error ? error.message : String(error)}\n`);
      throw error;
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
      // Write to stderr instead of using console.log to avoid breaking MCP protocol
      process.stderr.write(`[MCP Error] ${error.message}\n`);
    };

    process.on('SIGINT', async () => {
      await this.stop();
      process.exit(0);
    });

    // Handle uncaught exceptions
    process.on('uncaughtException', (error) => {
      process.stderr.write(`[Uncaught Exception] ${error.message}\n`);
      process.exit(1);
    });

    // Handle unhandled promise rejections
    process.on('unhandledRejection', (reason) => {
      process.stderr.write(`[Unhandled Rejection] ${reason}\n`);
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
          process.stderr.write(`Handling fireflies_get_transcripts with args: ${JSON.stringify(args)}\n`);
          
          try {
            // Create a promise that will timeout after 90 seconds
            const timeoutPromise = new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error('Request timed out after 90 seconds')), 90000);
            });
            
            // Race the actual API call against the timeout
            const transcripts = await Promise.race([
              this.apiClient.getTranscripts(limit, from_date, to_date),
              timeoutPromise
            ]);
            
            process.stderr.write(`Successfully retrieved ${transcripts.length} transcripts\n`);
            
            let resultText = JSON.stringify(transcripts, null, 2);
            
            // Add helpful message if only a few results were returned
            if (transcripts.length <= 1) {
              resultText += `\n\nNote: Only ${transcripts.length} transcript(s) were found. This might be due to:
1. Limited data in your Fireflies account
2. Date filters restricting results
3. API permissions or visibility settings

To retrieve more transcripts, you can:
- Specify a wider date range using from_date and to_date parameters
- Increase the limit parameter (default is 20)
- Check your Fireflies account permissions and settings`;
            }
            
            return {
              toolResult: {
                content: [{
                  type: "text",
                  text: resultText
                }]
              }
            };
          } catch (error) {
            process.stderr.write(`Error in fireflies_get_transcripts: ${error instanceof Error ? error.message : String(error)}\n`);
            
            // If we hit a timeout, try with minimal fields
            if (error instanceof Error && error.message.includes('timeout')) {
              process.stderr.write(`Trying with minimal fields due to timeout...\n`);
              const minimalTranscripts = await this.apiClient.getTranscripts(limit, from_date, to_date, true);
              
              let resultText = JSON.stringify(minimalTranscripts, null, 2);
              
              // Add helpful message
              resultText += `\n\nNote: Due to timeout, only minimal transcript data was retrieved. 
For more details, try requesting specific transcripts using their IDs.

If you're only seeing a few results, this might be due to:
1. Limited data in your Fireflies account
2. Default date range (no specific dates were provided)
3. API permissions or visibility settings

To retrieve more transcripts, you can:
- Specify a wider date range using from_date and to_date parameters
- Increase the limit parameter (default is 20)
- Check your Fireflies account permissions and settings`;
              
              return {
                toolResult: {
                  content: [{
                    type: "text",
                    text: resultText
                  }]
                }
              };
            }
            
            // Re-throw if it's not a timeout
            throw error;
          }
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
          
          process.stderr.write(`Generating summary for transcript ID: ${transcript_id} with format: ${format}\n`);
          
          try {
            const summary = await this.apiClient.generateTranscriptSummary(transcript_id, format);
            
            return {
              toolResult: {
                content: [{
                  type: "text",
                  text: summary
                }]
              }
            };
          } catch (error) {
            process.stderr.write(`Error generating summary: ${error instanceof Error ? error.message : String(error)}\n`);
            
            // If the error is related to missing summary data, provide a helpful message
            if (error instanceof McpError && 
                error.message.includes('Summary not available')) {
              return {
                toolResult: {
                  content: [{
                    type: "text",
                    text: `No summary is available for this transcript (ID: ${transcript_id}). This might be because:
1. The transcript is still being processed
2. The transcript is too short to generate a meaningful summary
3. The summary feature is not enabled for your account

You can try:
- Checking the transcript details to see if it has been fully processed
- Using a different transcript ID
- Contacting Fireflies support if you believe this is an error`
                  }]
                }
              };
            }
            
            // For other errors, re-throw
            throw error;
          }
        }

        default:
          throw new McpError(
            ErrorCode.MethodNotFound,
            `Unknown tool: ${name}`
          );
      }
    } catch (error) {
      process.stderr.write(`Error in handleToolCall for ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
      
      if (error instanceof McpError) {
        throw error;
      }
      
      // Ensure we're returning a proper McpError
      if (error instanceof Error) {
        throw new McpError(
          ErrorCode.InternalError,
          `Error processing request: ${error.message}`
        );
      } else {
        throw new McpError(
          ErrorCode.InternalError,
          `Unknown error occurred`
        );
      }
    }
  }

  /**
   * Starts the server
   */
  async start(): Promise<void> {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    // Write to stderr to avoid breaking MCP protocol
    process.stderr.write('Fireflies MCP server is running\n');
  }

  /**
   * Stops the server
   */
  async stop(): Promise<void> {
    try {
      await this.server.close();
    } catch (error) {
      process.stderr.write(`Error while stopping server: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
}

// Main execution
async function main() {
  const server = new FirefliesServer();
  
  try {
    await server.start();
  } catch (error) {
    process.stderr.write(`Server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  process.stderr.write(`Fatal server error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}); 