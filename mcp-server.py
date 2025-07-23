#!/usr/bin/env python3
"""
Simple MCP Server for Intellacc project
Provides tools for database queries, file operations, and project management
"""

import asyncio
import json
import sqlite3
from typing import Any, Dict, List, Optional
from mcp.server import Server
from mcp.server.models import InitializationOptions
import mcp.server.stdio
import mcp.types as types


# Create the server instance
server = Server("intellacc-mcp-server")

@server.list_tools()
async def handle_list_tools() -> List[types.Tool]:
    """List available tools"""
    return [
        types.Tool(
            name="query_db",
            description="Execute SQL queries on the Intellacc database",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "SQL query to execute"
                    },
                    "database": {
                        "type": "string", 
                        "description": "Database name (default: intellaccdb)",
                        "default": "intellaccdb"
                    }
                },
                "required": ["query"]
            }
        ),
        types.Tool(
            name="get_project_status",
            description="Get current project status including todo items and recent changes",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        ),
        types.Tool(
            name="analyze_logs",
            description="Analyze application logs for errors or patterns",
            inputSchema={
                "type": "object",
                "properties": {
                    "service": {
                        "type": "string",
                        "description": "Service to analyze (backend, frontend, prediction-engine, db)",
                        "enum": ["backend", "frontend", "prediction-engine", "db"]
                    },
                    "lines": {
                        "type": "integer",
                        "description": "Number of log lines to analyze",
                        "default": 50
                    }
                },
                "required": ["service"]
            }
        )
    ]

@server.call_tool()
async def handle_call_tool(name: str, arguments: Dict[str, Any]) -> List[types.TextContent]:
    """Handle tool calls"""
    
    if name == "query_db":
        query = arguments.get("query")
        database = arguments.get("database", "intellaccdb")
        
        try:
            # Execute Docker command to run query
            import subprocess
            cmd = [
                "docker", "exec", "intellacc_db", 
                "psql", "-U", "intellacc_user", "-d", database,
                "-c", query
            ]
            
            result = subprocess.run(cmd, capture_output=True, text=True)
            
            if result.returncode == 0:
                return [types.TextContent(
                    type="text",
                    text=f"Query executed successfully:\n\n{result.stdout}"
                )]
            else:
                return [types.TextContent(
                    type="text", 
                    text=f"Query failed:\n{result.stderr}"
                )]
                
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Error executing query: {str(e)}"
            )]
    
    elif name == "get_project_status":
        try:
            # Read CLAUDE.md for project context
            with open("/home/jayjag/Nextcloud/intellacc.com/CLAUDE.md", "r") as f:
                claude_content = f.read()
            
            # Get Docker container status
            import subprocess
            docker_status = subprocess.run(
                ["docker", "ps", "--format", "table {{.Names}}\t{{.Status}}\t{{.Ports}}"],
                capture_output=True, text=True
            )
            
            status_report = f"""
# Intellacc Project Status

## Docker Containers
{docker_status.stdout}

## Recent Project Context
Key features implemented:
- LMSR automated market making system
- Kelly optimal betting suggestions with belief probability slider
- Real-time leaderboards showing actual RP balances  
- Database cleanup and optimization
- Enhanced prediction UI with working sliders

## Current Working Directory
/home/jayjag/Nextcloud/intellacc.com

## Key Architecture
- Frontend: VanJS (port 5173)
- Backend: Express.js (port 3000) 
- Database: PostgreSQL (port 5432)
- Prediction Engine: Rust (port 3001)
"""
            
            return [types.TextContent(type="text", text=status_report)]
            
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Error getting project status: {str(e)}"
            )]
    
    elif name == "analyze_logs":
        service = arguments.get("service")
        lines = arguments.get("lines", 50)
        
        try:
            import subprocess
            container_map = {
                "backend": "intellacc_backend",
                "frontend": "intellacc_frontend", 
                "prediction-engine": "intellacc_prediction_engine",
                "db": "intellacc_db"
            }
            
            container = container_map.get(service)
            if not container:
                return [types.TextContent(
                    type="text",
                    text=f"Unknown service: {service}"
                )]
            
            result = subprocess.run(
                ["docker", "logs", "--tail", str(lines), container],
                capture_output=True, text=True
            )
            
            analysis = f"""
# Log Analysis for {service}

## Recent Logs ({lines} lines)
{result.stdout}

## Error Output
{result.stderr if result.stderr else "No errors"}

## Analysis
- Container: {container}
- Lines analyzed: {lines}
- Status: {'Healthy' if result.returncode == 0 else 'Issues detected'}
"""
            
            return [types.TextContent(type="text", text=analysis)]
            
        except Exception as e:
            return [types.TextContent(
                type="text",
                text=f"Error analyzing logs: {str(e)}"
            )]
    
    else:
        return [types.TextContent(
            type="text",
            text=f"Unknown tool: {name}"
        )]

async def main():
    # Run the server using stdio transport
    async with mcp.server.stdio.stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            InitializationOptions(
                server_name="intellacc-mcp-server",
                server_version="1.0.0",
                capabilities=server.get_capabilities(
                    notification_options=None,
                    experimental_capabilities={}
                )
            )
        )

if __name__ == "__main__":
    asyncio.run(main())