#!/usr/bin/env node

import { createServer as createHttpServer, IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { BookStackClient, BookStackConfig } from "./bookstack-client.js";

function getRequiredEnvVar(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Error: ${name} environment variable is required`);
    process.exit(1);
  }
  return value;
}

function buildServer(config: BookStackConfig): McpServer {
  const client = new BookStackClient(config);
  const server = new McpServer({
    name: "bookstack-mcp",
    version: "2.1.0"
  });

  registerTools(server, client, config);
  return server;
}

function registerTools(server: McpServer, client: BookStackClient, config: BookStackConfig): void {
  // Register read-only tools
  server.registerTool(
    "get_capabilities",
    {
      title: "Get BookStack Capabilities",
      description: "Get information about available BookStack MCP capabilities and current configuration",
      inputSchema: {}
    },
    async () => {
      const capabilities = {
        server_name: "BookStack MCP Server",
        version: "2.1.0",
        write_operations_enabled: config.enableWrite,
        available_tools: config.enableWrite ? "All tools enabled" : "Read-only tools only",
        security_note: config.enableWrite
          ? "⚠️  Write operations are ENABLED - AI can create and modify BookStack content"
          : "🛡️  Read-only mode - Safe for production use"
      };
      return {
        content: [{ type: "text", text: JSON.stringify(capabilities, null, 2) }]
      };
    }
  );

  server.registerTool(
    "search_content",
    {
      title: "Search BookStack Content",
      description: "Search across BookStack content with contextual previews and location info",
      inputSchema: {
        query: z.string().describe("Search query. Use BookStack advanced search syntax like {type:page} or {book_id:5}"),
        type: z.enum(["book", "page", "chapter", "bookshelf"]).optional().describe("Filter by content type"),
        count: z.coerce.number().max(500).optional().describe("Number of results to return (max 500)"),
        offset: z.coerce.number().optional().describe("Number of results to skip for pagination")
      }
    },
    async (args) => {
      const results = await client.searchContent(args.query, {
        type: args.type,
        count: args.count,
        offset: args.offset
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
      };
    }
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search Pages",
      description: "Search specifically for pages with optional book filtering",
      inputSchema: {
        query: z.string().describe("Search query for pages"),
        book_id: z.coerce.number().optional().describe("Filter results to pages within a specific book"),
        count: z.coerce.number().max(500).optional().describe("Number of results to return"),
        offset: z.coerce.number().optional().describe("Pagination offset")
      }
    },
    async (args) => {
      const results = await client.searchPages(args.query, {
        bookId: args.book_id,
        count: args.count,
        offset: args.offset
      });
      return {
        content: [{ type: "text", text: JSON.stringify(results, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_books",
    {
      title: "List Books",
      description: "List available books with advanced filtering and sorting",
      inputSchema: {
        offset: z.coerce.number().default(0).describe("Pagination offset"),
        count: z.coerce.number().max(500).default(50).describe("Number of results to return"),
        sort: z.string().optional().describe("Sort field (e.g., 'name', '-created_at', 'updated_at')"),
        filter: z.record(z.any()).optional().describe("Filter criteria")
      }
    },
    async (args) => {
      const books = await client.getBooks({
        offset: args.offset,
        count: args.count,
        sort: args.sort,
        filter: args.filter
      });
      return {
        content: [{ type: "text", text: JSON.stringify(books, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_book",
    {
      title: "Get Book Details",
      description: "Get detailed information about a specific book",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Book ID")
      }
    },
    async (args) => {
      const book = await client.getBook(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(book, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_pages",
    {
      title: "List Pages",
      description: "List pages with content previews, word counts, and contextual information",
      inputSchema: {
        book_id: z.coerce.number().optional().describe("Filter by book ID"),
        chapter_id: z.coerce.number().optional().describe("Filter by chapter ID"),
        offset: z.coerce.number().default(0).describe("Pagination offset"),
        count: z.coerce.number().max(500).default(50).describe("Number of results to return"),
        sort: z.string().optional().describe("Sort field"),
        filter: z.record(z.any()).optional().describe("Additional filter criteria")
      }
    },
    async (args) => {
      const pages = await client.getPages({
        bookId: args.book_id,
        chapterId: args.chapter_id,
        offset: args.offset,
        count: args.count,
        sort: args.sort,
        filter: args.filter
      });
      return {
        content: [{ type: "text", text: JSON.stringify(pages, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_page",
    {
      title: "Get Page Content",
      description: "Get content of a specific page. Returns one content format (default markdown) and supports character-range pagination so large pages don't blow the context window. Use offset/limit or the returned content_next_offset to page through long content.",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Page ID"),
        format: z.enum(["markdown", "html", "text"]).optional().describe("Which content format to return. Defaults to markdown."),
        offset: z.coerce.number().min(0).optional().describe("Character offset into the content to start from (default 0)"),
        limit: z.coerce.number().min(1).max(200000).optional().describe("Max characters of content to return (default 50000)")
      }
    },
    async (args) => {
      const page = await client.getPage(args.id, {
        format: args.format,
        offset: args.offset,
        limit: args.limit
      });
      return {
        content: [{ type: "text", text: JSON.stringify(page, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_chapters",
    {
      title: "List Chapters",
      description: "List chapters, optionally filtered by book",
      inputSchema: {
        book_id: z.coerce.number().optional().describe("Filter by book ID"),
        offset: z.coerce.number().default(0).describe("Pagination offset"),
        count: z.coerce.number().default(50).describe("Number of results to return")
      }
    },
    async (args) => {
      const chapters = await client.getChapters(args.book_id, args.offset, args.count);
      return {
        content: [{ type: "text", text: JSON.stringify(chapters, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_chapter",
    {
      title: "Get Chapter Details",
      description: "Get details of a specific chapter",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Chapter ID")
      }
    },
    async (args) => {
      const chapter = await client.getChapter(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(chapter, null, 2) }]
      };
    }
  );

  server.registerTool(
    "export_page",
    {
      title: "Export Page",
      description: "Export a page in various formats (PDF/ZIP provide direct BookStack download URLs)",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Page ID"),
        format: z.enum(["html", "pdf", "markdown", "plaintext", "zip"]).describe("Export format")
      }
    },
    async (args) => {
      const content = await client.exportPage(args.id, args.format);

      // Handle binary formats with direct URLs
      if (typeof content === 'object' && content.download_url && content.direct_download) {
        const format = args.format.toUpperCase();
        return {
          content: [{
            type: "text",
            text: `✅ **${format} Export Ready**\n\n` +
                  `📄 **Page:** ${content.page_name}\n` +
                  `📚 **Book:** ${content.book_name}\n` +
                  `📁 **File:** ${content.filename}\n\n` +
                  `🚀 **Direct Download Link:**\n${content.download_url}\n\n` +
                  `ℹ️  **Note:** ${content.note}`
          }]
        };
      }

      // Handle text formats
      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return {
        content: [{ type: "text", text }]
      };
    }
  );

  server.registerTool(
    "export_book",
    {
      title: "Export Book",
      description: "Export an entire book in various formats",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Book ID"),
        format: z.enum(["html", "pdf", "markdown", "plaintext", "zip"]).describe("Export format")
      }
    },
    async (args) => {
      const content = await client.exportBook(args.id, args.format);

      if (typeof content === 'object' && content.download_url) {
        const format = args.format.toUpperCase();
        return {
          content: [{
            type: "text",
            text: `✅ **${format} Book Export Ready**\n\n` +
                  `📚 **Book:** ${content.book_name}\n` +
                  `📁 **File:** ${content.filename}\n\n` +
                  `🚀 **Direct Download Link:**\n${content.download_url}\n\n` +
                  `ℹ️  **Note:** ${content.note}`
          }]
        };
      }

      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return {
        content: [{ type: "text", text }]
      };
    }
  );

  server.registerTool(
    "export_chapter",
    {
      title: "Export Chapter",
      description: "Export a chapter in various formats",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Chapter ID"),
        format: z.enum(["html", "pdf", "markdown", "plaintext", "zip"]).describe("Export format")
      }
    },
    async (args) => {
      const content = await client.exportChapter(args.id, args.format);

      if (typeof content === 'object' && content.download_url) {
        const format = args.format.toUpperCase();
        return {
          content: [{
            type: "text",
            text: `✅ **${format} Chapter Export Ready**\n\n` +
                  `📖 **Chapter:** ${content.chapter_name}\n` +
                  `📚 **Book:** ${content.book_name}\n` +
                  `📁 **File:** ${content.filename}\n\n` +
                  `🚀 **Direct Download Link:**\n${content.download_url}\n\n` +
                  `ℹ️  **Note:** ${content.note}`
          }]
        };
      }

      const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
      return {
        content: [{ type: "text", text }]
      };
    }
  );

  server.registerTool(
    "get_recent_changes",
    {
      title: "Get Recent Changes",
      description: "Get recently updated content with contextual previews and change descriptions",
      inputSchema: {
        type: z.enum(["all", "page", "book", "chapter"]).default("all").describe("Filter by content type"),
        limit: z.coerce.number().max(100).default(20).describe("Number of recent items to return"),
        days: z.coerce.number().default(30).describe("Number of days back to look for changes")
      }
    },
    async (args) => {
      const changes = await client.getRecentChanges({
        type: args.type,
        limit: args.limit,
        days: args.days
      });
      return {
        content: [{ type: "text", text: JSON.stringify(changes, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_shelves",
    {
      title: "List Shelves",
      description: "List available book shelves (collections) with filtering and sorting",
      inputSchema: {
        offset: z.coerce.number().default(0).describe("Pagination offset"),
        count: z.coerce.number().max(500).default(50).describe("Number of results to return"),
        sort: z.string().optional().describe("Sort field"),
        filter: z.record(z.any()).optional().describe("Filter criteria")
      }
    },
    async (args) => {
      const shelves = await client.getShelves({
        offset: args.offset,
        count: args.count,
        sort: args.sort,
        filter: args.filter
      });
      return {
        content: [{ type: "text", text: JSON.stringify(shelves, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_shelf",
    {
      title: "Get Shelf Details",
      description: "Get details of a specific book shelf including all books",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Shelf ID")
      }
    },
    async (args) => {
      const shelf = await client.getShelf(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(shelf, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_attachments",
    {
      title: "List Attachments",
      description: "List attachments (files and links) with filtering and sorting",
      inputSchema: {
        offset: z.coerce.number().default(0).describe("Pagination offset"),
        count: z.coerce.number().max(500).default(50).describe("Number of results to return"),
        sort: z.string().optional().describe("Sort field"),
        filter: z.record(z.any()).optional().describe("Filter criteria")
      }
    },
    async (args) => {
      const attachments = await client.getAttachments({
        offset: args.offset,
        count: args.count,
        sort: args.sort,
        filter: args.filter
      });
      return {
        content: [{ type: "text", text: JSON.stringify(attachments, null, 2) }]
      };
    }
  );

  server.registerTool(
    "get_attachment",
    {
      title: "Get Attachment Details",
      description: "Get details of a specific attachment including download links",
      inputSchema: {
        id: z.coerce.number().min(1).describe("Attachment ID")
      }
    },
    async (args) => {
      const attachment = await client.getAttachment(args.id);
      return {
        content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
      };
    }
  );

  // Register write tools if enabled
  if (config.enableWrite) {
    server.registerTool(
      "create_page",
      {
        title: "Create Page",
        description: "Create a new page in BookStack",
        inputSchema: {
          name: z.string().describe("Page name"),
          book_id: z.coerce.number().min(1).describe("Book ID where the page will be created"),
          chapter_id: z.coerce.number().optional().describe("Optional: Chapter ID if page should be in a chapter"),
          html: z.string().optional().describe("Optional: HTML content"),
          markdown: z.string().optional().describe("Optional: Markdown content")
        }
      },
      async (args) => {
        const page = await client.createPage({
          name: args.name,
          book_id: args.book_id,
          chapter_id: args.chapter_id,
          html: args.html,
          markdown: args.markdown
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page, null, 2) }]
        };
      }
    );

    server.registerTool(
      "update_page",
      {
        title: "Update Page",
        description: "Update an existing page",
        inputSchema: {
          id: z.coerce.number().min(1).describe("Page ID"),
          name: z.string().optional().describe("Optional: New page name"),
          html: z.string().optional().describe("Optional: New HTML content"),
          markdown: z.string().optional().describe("Optional: New Markdown content")
        }
      },
      async (args) => {
        const page = await client.updatePage(args.id, {
          name: args.name,
          html: args.html,
          markdown: args.markdown
        });
        return {
          content: [{ type: "text", text: JSON.stringify(page, null, 2) }]
        };
      }
    );

    server.registerTool(
      "create_shelf",
      {
        title: "Create Shelf",
        description: "Create a new book shelf (collection)",
        inputSchema: {
          name: z.string().describe("Shelf name"),
          description: z.string().optional().describe("Shelf description"),
          books: z.array(z.coerce.number()).optional().describe("Array of book IDs to add to the shelf"),
          tags: z.array(z.object({
            name: z.string(),
            value: z.string()
          }).strict()).optional().describe("Tags for the shelf")
        }
      },
      async (args) => {
        const shelf = await client.createShelf({
          name: args.name,
          description: args.description,
          books: args.books,
          tags: args.tags as any
        });
        return {
          content: [{ type: "text", text: JSON.stringify(shelf, null, 2) }]
        };
      }
    );

    server.registerTool(
      "update_shelf",
      {
        title: "Update Shelf",
        description: "Update an existing book shelf",
        inputSchema: {
          id: z.coerce.number().min(1).describe("Shelf ID"),
          name: z.string().optional().describe("New shelf name"),
          description: z.string().optional().describe("New shelf description"),
          books: z.array(z.coerce.number()).optional().describe("Array of book IDs"),
          tags: z.array(z.object({
            name: z.string(),
            value: z.string()
          }).strict()).optional().describe("Tags for the shelf")
        }
      },
      async (args) => {
        const shelf = await client.updateShelf(args.id, {
          name: args.name,
          description: args.description,
          books: args.books,
          tags: args.tags as any
        });
        return {
          content: [{ type: "text", text: JSON.stringify(shelf, null, 2) }]
        };
      }
    );

    server.registerTool(
      "delete_shelf",
      {
        title: "Delete Shelf",
        description: "Delete a book shelf (collection)",
        inputSchema: {
          id: z.coerce.number().min(1).describe("Shelf ID")
        }
      },
      async (args) => {
        const result = await client.deleteShelf(args.id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    );

    server.registerTool(
      "create_attachment",
      {
        title: "Create Attachment",
        description: "Create a new link attachment to a page",
        inputSchema: {
          name: z.string().describe("Attachment name"),
          uploaded_to: z.coerce.number().min(1).describe("Page ID where attachment will be attached"),
          link: z.string().describe("URL for link attachment")
        }
      },
      async (args) => {
        const attachment = await client.createAttachment({
          name: args.name,
          uploaded_to: args.uploaded_to,
          link: args.link
        });
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      }
    );

    server.registerTool(
      "update_attachment",
      {
        title: "Update Attachment",
        description: "Update an existing attachment",
        inputSchema: {
          id: z.coerce.number().min(1).describe("Attachment ID"),
          name: z.string().optional().describe("New attachment name"),
          link: z.string().optional().describe("New URL for link attachment"),
          uploaded_to: z.coerce.number().optional().describe("Move attachment to different page")
        }
      },
      async (args) => {
        const attachment = await client.updateAttachment(args.id, {
          name: args.name,
          link: args.link,
          uploaded_to: args.uploaded_to
        });
        return {
          content: [{ type: "text", text: JSON.stringify(attachment, null, 2) }]
        };
      }
    );

    server.registerTool(
      "delete_attachment",
      {
        title: "Delete Attachment",
        description: "Delete an attachment",
        inputSchema: {
          id: z.coerce.number().min(1).describe("Attachment ID")
        }
      },
      async (args) => {
        const result = await client.deleteAttachment(args.id);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
    );
  }

}

async function startStdio(config: BookStackConfig): Promise<void> {
  const server = buildServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("BookStack MCP server running on stdio");
}

type AnyTransport = StreamableHTTPServerTransport | SSEServerTransport;

async function startHttp(config: BookStackConfig): Promise<void> {
  const port = parseInt(process.env.MCP_HTTP_PORT ?? "8080", 10);
  const host = process.env.MCP_HTTP_HOST ?? "0.0.0.0";
  const mcpPath = process.env.MCP_HTTP_PATH ?? "/mcp";
  const ssePath = process.env.MCP_SSE_PATH ?? "/sse";
  const messagesPath = process.env.MCP_MESSAGES_PATH ?? "/messages";

  const transports: Record<string, AnyTransport> = {};

  const readJsonBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        if (!raw) return resolve(undefined);
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
      req.on("error", reject);
    });

  const sendJson = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const httpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // Streamable HTTP endpoint (recommended)
      if (pathname === mcpPath) {
        const sessionId = req.headers["mcp-session-id"] as string | undefined;
        let transport: StreamableHTTPServerTransport | undefined;
        let parsedBody: unknown;

        if (req.method === "POST") {
          parsedBody = await readJsonBody(req);
        }

        if (sessionId && transports[sessionId] instanceof StreamableHTTPServerTransport) {
          transport = transports[sessionId] as StreamableHTTPServerTransport;
        } else if (!sessionId && req.method === "POST" && isInitializeRequest(parsedBody)) {
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (sid) => {
              transports[sid] = transport!;
            }
          });
          transport.onclose = () => {
            const sid = transport!.sessionId;
            if (sid && transports[sid]) delete transports[sid];
          };
          const server = buildServer(config);
          await server.connect(transport);
        } else {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: No valid session ID provided" },
            id: null
          });
          return;
        }

        await transport.handleRequest(req, res, parsedBody);
        return;
      }

      // Legacy SSE transport: GET /sse establishes the stream
      if (pathname === ssePath && req.method === "GET") {
        const transport = new SSEServerTransport(messagesPath, res);
        transports[transport.sessionId] = transport;
        res.on("close", () => {
          delete transports[transport.sessionId];
        });
        const server = buildServer(config);
        await server.connect(transport);
        return;
      }

      // Legacy SSE transport: POST /messages?sessionId=...
      if (pathname === messagesPath && req.method === "POST") {
        const sid = url.searchParams.get("sessionId") ?? "";
        const existing = transports[sid];
        if (!(existing instanceof SSEServerTransport)) {
          sendJson(res, 400, {
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: Unknown or wrong-protocol session" },
            id: null
          });
          return;
        }
        const parsedBody = await readJsonBody(req);
        await existing.handlePostMessage(req, res, parsedBody);
        return;
      }

      // Health check
      if (pathname === "/health" || pathname === "/") {
        sendJson(res, 200, { status: "ok", server: "bookstack-mcp", transport: "http" });
        return;
      }

      sendJson(res, 404, { error: "Not Found" });
    } catch (err) {
      console.error("HTTP handler error:", err);
      if (!res.headersSent) {
        sendJson(res, 500, {
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  httpServer.listen(port, host, () => {
    console.error(`BookStack MCP server listening on http://${host}:${port}`);
    console.error(`  Streamable HTTP: ${mcpPath}  (recommended)`);
    console.error(`  Legacy SSE:      GET ${ssePath}, POST ${messagesPath}?sessionId=...`);
  });

  const shutdown = async () => {
    console.error("Shutting down HTTP server...");
    for (const sid of Object.keys(transports)) {
      try { await transports[sid].close(); } catch {}
      delete transports[sid];
    }
    httpServer.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function main() {
  const config: BookStackConfig = {
    baseUrl: getRequiredEnvVar('BOOKSTACK_BASE_URL'),
    tokenId: getRequiredEnvVar('BOOKSTACK_TOKEN_ID'),
    tokenSecret: getRequiredEnvVar('BOOKSTACK_TOKEN_SECRET'),
    enableWrite: process.env.BOOKSTACK_ENABLE_WRITE?.toLowerCase() === 'true'
  };

  console.error('Initializing BookStack MCP Server...');
  console.error(`BookStack URL: ${config.baseUrl}`);
  console.error(`Write operations: ${config.enableWrite ? 'ENABLED' : 'DISABLED'}`);

  const transportMode = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transportMode === "http" || transportMode === "sse") {
    await startHttp(config);
  } else {
    await startStdio(config);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
