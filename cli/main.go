package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"

	"github.com/alecthomas/kong"
)

// CLI struct holds the top-level command line definitions
type CLI struct {
	JSON   bool   `help:"Output as strict JSON." env:"INTELLACC_JSON"`
	APIKey string `help:"Intellacc API Key." env:"INTELLACC_API_KEY"`
	APIURL string `help:"Intellacc API URL." default:"http://localhost:5173" env:"INTELLACC_API_URL"`

	Config ConfigCmd `cmd:"" help:"Manage configuration and authentication."`
	Market MarketCmd `cmd:"" help:"Interact with prediction markets."`
	Social SocialCmd `cmd:"" help:"Interact with the social feed."`
}

// ---------------------------------------------------------
// HTTP Helper
// ---------------------------------------------------------

func (cli *CLI) request(method, path string, body io.Reader) (*http.Response, error) {
	url := fmt.Sprintf("%s%s", cli.APIURL, path)
	req, err := http.NewRequest(method, url, body)
	if err != nil {
		return nil, err
	}

	req.Header.Set("Content-Type", "application/json")
	if cli.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cli.APIKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	return client.Do(req)
}

// ---------------------------------------------------------
// Config Commands
// ---------------------------------------------------------

type ConfigCmd struct {
	Verify VerifyCmd `cmd:"" help:"Verify the current configuration."`
}

type VerifyCmd struct{}

func (cmd *VerifyCmd) Run(cli *CLI) error {
	// 1. Check health
	resp, err := cli.request("GET", "/api/health-check", nil)
	if err != nil {
		return fmt.Errorf("backend health check failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("backend returned non-200 status: %d", resp.StatusCode)
	}

	var health struct {
		Status  string `json:"status"`
		Message string `json:"message"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&health); err != nil {
		return fmt.Errorf("failed to decode health response: %w", err)
	}

	// 2. Verify API Key if provided
	authStatus := "not_checked"
	if cli.APIKey != "" {
		resp, err = cli.request("GET", "/api/verification/status", nil)
		if err == nil {
			defer resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				authStatus = "valid"
			} else {
				authStatus = "invalid"
			}
		}
	} else {
		authStatus = "missing"
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status":      "success",
			"health":      health,
			"auth_status": authStatus,
			"api_url":     cli.APIURL,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Backend Health: %s (%s)\n", health.Status, health.Message)
		fmt.Printf("🔑 Auth Status:    %s\n", authStatus)
		fmt.Printf("🌐 API URL:        %s\n", cli.APIURL)
	}

	return nil
}

// ---------------------------------------------------------
// Market Commands
// ---------------------------------------------------------

type MarketCmd struct {
	List  MarketListCmd  `cmd:"" help:"List active markets."`
	Get   MarketGetCmd   `cmd:"" help:"Get market details."`
	Trade MarketTradeCmd `cmd:"" help:"Execute a trade."`
}

type MarketListCmd struct {
	Status string `enum:"open,closed,resolved" default:"open" help:"Filter by market status."`
	Limit  int    `default:"10" help:"Number of markets to return."`
}

func (cmd *MarketListCmd) Run(cli *CLI) error {
	path := fmt.Sprintf("/api/events")
	
	resp, err := cli.request("GET", path, nil)
	if err != nil {
		return fmt.Errorf("failed to fetch markets: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	var result []interface{}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	// Simple client-side filtering and limiting since the endpoint doesn't seem to support query params directly
	var filtered []interface{}
	for i, item := range result {
		if i >= cmd.Limit {
			break
		}
		filtered = append(filtered, item)
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status": "success",
			"data":   filtered,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Found %d markets\n", len(filtered))
		for _, item := range filtered {
			if m, ok := item.(map[string]interface{}); ok {
				fmt.Printf(" - [%v] %v\n", m["id"], m["title"])
			}
		}
	}
	return nil
}

type MarketGetCmd struct {
	ID string `arg:"" help:"Market ID to fetch."`
}

func (cmd *MarketGetCmd) Run(cli *CLI) error {
	path := fmt.Sprintf("/api/events/%s/market", cmd.ID)
	resp, err := cli.request("GET", path, nil)
	if err != nil {
		return fmt.Errorf("failed to fetch market: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	var data interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status": "success",
			"data":   data,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Fetched market %s\n", cmd.ID)
		if m, ok := data.(map[string]interface{}); ok {
			if market, ok := m["market"].(map[string]interface{}); ok {
				fmt.Printf("   Prob: %v\n", market["market_prob"])
			}
		}
	}
	return nil
}

type MarketTradeCmd struct {
	ID         string  `arg:"" help:"Market ID to trade in."`
	TargetProb float64 `help:"Your belief/target probability (e.g. 0.75 for 75%)." required:""`
	Amount     int     `help:"Amount of shares/RP to stake."`
}

func (cmd *MarketTradeCmd) Run(cli *CLI) error {
	path := fmt.Sprintf("/api/events/%s/update", cmd.ID)

	if cmd.TargetProb <= 0.0 || cmd.TargetProb >= 1.0 {
		return fmt.Errorf("target probability must be between 0.0 and 1.0 (exclusive)")
	}

	payload := map[string]interface{}{
		"stake":       cmd.Amount,
		"target_prob": cmd.TargetProb,
	}
	bodyData, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", cli.APIURL+path, bytes.NewBuffer(bodyData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if cli.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cli.APIKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to execute trade: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	var data interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status": "success",
			"data":   data,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Successfully staked %d RP with target probability %.2f for market %s\n", cmd.Amount, cmd.TargetProb, cmd.ID)
	}
	return nil
}

// ---------------------------------------------------------
// Social Commands
// ---------------------------------------------------------

type SocialCmd struct {
	Feed SocialFeedCmd `cmd:"" help:"Read the social feed."`
	Post SocialPostCmd `cmd:"" help:"Create a new post."`
}

type SocialFeedCmd struct {
	Limit int `default:"5" help:"Number of posts to fetch."`
}

func (cmd *SocialFeedCmd) Run(cli *CLI) error {
	path := fmt.Sprintf("/api/feed?limit=%d", cmd.Limit)
	
	resp, err := cli.request("GET", path, nil)
	if err != nil {
		return fmt.Errorf("failed to fetch feed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	var result struct {
		Items []interface{} `json:"items"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status": "success",
			"data":   result.Items,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Fetched %d posts from the feed\n", len(result.Items))
		for _, p := range result.Items {
			if post, ok := p.(map[string]interface{}); ok {
				fmt.Printf(" - [%v] %v\n", post["id"], post["content"])
			}
		}
	}
	return nil
}

type SocialPostCmd struct {
	Content string `arg:"" help:"Content of the post."`
}

func (cmd *SocialPostCmd) Run(cli *CLI) error {
	path := "/api/posts"

	payload := map[string]string{
		"content": cmd.Content,
	}
	bodyData, _ := json.Marshal(payload)

	req, err := http.NewRequest("POST", cli.APIURL+path, bytes.NewBuffer(bodyData))
	if err != nil {
		return fmt.Errorf("failed to create request: %w", err)
	}

	req.Header.Set("Content-Type", "application/json")
	if cli.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+cli.APIKey)
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("failed to submit post: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusCreated && resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("API error (%d): %s", resp.StatusCode, string(body))
	}

	var data interface{}
	if err := json.NewDecoder(resp.Body).Decode(&data); err != nil {
		return fmt.Errorf("failed to decode response: %w", err)
	}

	if cli.JSON {
		out, _ := json.Marshal(map[string]interface{}{
			"status": "success",
			"data":   data,
		})
		fmt.Println(string(out))
	} else {
		fmt.Printf("✅ Post created successfully.\n")
	}
	return nil
}

func main() {
	var cli CLI
	ctx := kong.Parse(&cli,
		kong.Name("intellacc"),
		kong.Description("Headless CLI for the Intellacc Prediction Market & Social Platform."),
		kong.UsageOnError(),
	)

	err := ctx.Run(&cli)
	ctx.FatalIfErrorf(err)
}
