// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';

// Global state to store pending completion
let pendingCompletion: { text: string; position: vscode.Position } | null = null;

// Inline completion provider for LLM suggestions
class LLMInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
	async provideInlineCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		context: vscode.InlineCompletionContext,
		token: vscode.CancellationToken
	): Promise<vscode.InlineCompletionItem[] | vscode.InlineCompletionList | null> {
		// Only provide completion if we have a pending completion at this position
		if (!pendingCompletion || 
			pendingCompletion.position.line !== position.line || 
			pendingCompletion.position.character !== position.character) {
			return null;
		}

		const completionItem = new vscode.InlineCompletionItem(
			pendingCompletion.text,
			new vscode.Range(position, position)
		);

		// Clear the pending completion after providing it
		const completion = pendingCompletion.text;
		pendingCompletion = null;

		return [completionItem];
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {

	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "llcg" is now active!');

	// Register the inline completion provider
	const inlineCompletionProvider = vscode.languages.registerInlineCompletionItemProvider(
		{ pattern: '**' },
		new LLMInlineCompletionProvider()
	);
	context.subscriptions.push(inlineCompletionProvider);

	// Register the completion with LLM command
	const completionCommand = vscode.commands.registerCommand('llcg.completeWithLLM', async () => {
		const editor = vscode.window.activeTextEditor;
		
		if (!editor) {
			vscode.window.showErrorMessage('No active text editor');
			return;
		}

		const selection = editor.selection;
		const selectedText = editor.document.getText(selection);

		// Check if text is selected
		if (!selectedText || selectedText.length === 0) {
			vscode.window.showWarningMessage('Please select some text to complete with LLM');
			return;
		}

		// Show progress while generating completion
		await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: "Generating completion with LLM...",
			cancellable: false
		}, async (progress) => {
			try {
				const completion = await generateLLMCompletion(selectedText);
				
				// Store the completion and trigger inline completion at the end of selection
				pendingCompletion = {
					text: completion,
					position: selection.end
				};

				// Move cursor to the end of selection
				editor.selection = new vscode.Selection(selection.end, selection.end);

				// Trigger inline completion suggestions
				await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');

				vscode.window.showInformationMessage('Completion ready! Press Tab to accept.');
			} catch (error) {
				vscode.window.showErrorMessage(`Failed to generate completion: ${error}`);
			}
		});
	});

	context.subscriptions.push(completionCommand);

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('llcg.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from LLCG!');
	});

	context.subscriptions.push(disposable);
}

// Function to generate completion using LLM (Ollama)
async function generateLLMCompletion(selectedText: string): Promise<string> {
	// Get configuration settings
	const config = vscode.workspace.getConfiguration('llcg');
	const model = config.get<string>('modelName') || 'Question_reformer_qwen:latest';
	const ollamaUrl = config.get<string>('ollamaUrl') || 'http://localhost:11434/api/generate';

	// Chat templates
	const reformChatTemplate = `<|im_start|>system
Give me a well formatted task description that matches the user's code snippet.<|im_end|>
<|im_start|>user
{prompt}<|im_end|>
<|im_start|>assistant`;

	const codingChatTemplate = `<|im_start|>system
You are a helpful assistant.<|im_end|>
<|im_start|>user
{improved_prompt}<|im_end|>
<|im_start|>assistant
\`\`\`python
{original_prompt}
`;

	try {
		// Step 1: Reformulate the prompt
		const reformPrompt = reformChatTemplate.replace('{prompt}', selectedText);
		const improvedPrompt = await callOllama(ollamaUrl, model, reformPrompt);

		// Step 2: Generate code based on improved prompt
		const codingPrompt = codingChatTemplate
			.replace('{improved_prompt}', improvedPrompt)
			.replace('{original_prompt}', selectedText);
		
		let codeCompletion = await callOllama(ollamaUrl, model, codingPrompt);

		// Remove trailing ``` if present
		if (codeCompletion.endsWith('```')) {
			codeCompletion = codeCompletion.slice(0, -3).trimEnd();
		}

		// Add newline at the beginning
		codeCompletion = '\n    ' + codeCompletion;

		return codeCompletion;
	} catch (error) {
		throw new Error(`LLM API call failed: ${error}`);
	}
}

// Helper function to call Ollama API and stream response
async function callOllama(url: string, model: string, prompt: string): Promise<string> {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
		},
		body: JSON.stringify({
			model: model,
			prompt: prompt,
			stream: true
		})
	});

	if (!response.ok) {
		throw new Error(`HTTP error! status: ${response.status}`);
	}

	let fullResponse = '';
	const reader = response.body?.getReader();
	const decoder = new TextDecoder();

	if (!reader) {
		throw new Error('No response body reader available');
	}

	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			break;
		}

		const chunk = decoder.decode(value);
		const lines = chunk.split('\n').filter(line => line.trim());

		for (const line of lines) {
			try {
				const data = JSON.parse(line);
				if (data.response) {
					fullResponse += data.response;
				}
			} catch (e) {
				// Skip invalid JSON lines
				console.error('Failed to parse JSON line:', e);
			}
		}
	}

	return fullResponse.trim();
}

// This method is called when your extension is deactivated
export function deactivate() {}
