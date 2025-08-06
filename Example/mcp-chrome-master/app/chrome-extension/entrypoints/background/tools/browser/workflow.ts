/**
 * Workflow orchestration tools for complex browser automation
 */

import { createErrorResponse, createSuccessResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { TOOL_NAMES, WorkflowDefinition, WorkflowTemplate, WaitCondition } from 'chrome-mcp-shared';
import { workflowEngine } from '@/utils/workflow-engine';

/**
 * Template storage using Chrome storage API
 */
class WorkflowTemplateStorage {
  private readonly STORAGE_KEY = 'workflow_templates';

  async saveTemplate(template: WorkflowTemplate): Promise<void> {
    const templates = await this.getAllTemplates();
    templates[template.name] = {
      ...template,
      updatedAt: new Date().toISOString()
    };
    
    await chrome.storage.local.set({ [this.STORAGE_KEY]: templates });
  }

  async loadTemplate(name: string): Promise<WorkflowTemplate | null> {
    const templates = await this.getAllTemplates();
    return templates[name] || null;
  }

  async getAllTemplates(): Promise<Record<string, WorkflowTemplate>> {
    const result = await chrome.storage.local.get([this.STORAGE_KEY]);
    return result[this.STORAGE_KEY] || {};
  }

  async deleteTemplate(name: string): Promise<boolean> {
    const templates = await this.getAllTemplates();
    if (templates[name]) {
      delete templates[name];
      await chrome.storage.local.set({ [this.STORAGE_KEY]: templates });
      return true;
    }
    return false;
  }

  async listTemplates(category?: string): Promise<WorkflowTemplate[]> {
    const templates = await this.getAllTemplates();
    const templateList = Object.values(templates);
    
    if (category) {
      return templateList.filter(t => t.category === category);
    }
    
    return templateList;
  }
}

const templateStorage = new WorkflowTemplateStorage();

/**
 * Tool for executing complex workflows
 */
class WorkflowExecuteTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WORKFLOW_EXECUTE;

  async execute(args: { workflow: WorkflowDefinition }): Promise<ToolResult> {
    try {
      const { workflow } = args;

      if (!workflow || !workflow.name || !workflow.steps || workflow.steps.length === 0) {
        return createErrorResponse('Invalid workflow: must have name and at least one step');
      }

      console.log(`Executing workflow: ${workflow.name} with ${workflow.steps.length} steps`);

      // Validate workflow steps
      const validation = this.validateWorkflow(workflow);
      if (!validation.valid) {
        return createErrorResponse(`Workflow validation failed: ${validation.error}`);
      }

      // Execute the workflow
      const execution = await workflowEngine.executeWorkflow(workflow);

      const result = {
        success: true,
        executionId: execution.id,
        workflowName: workflow.name,
        status: execution.status,
        startTime: execution.startTime,
        endTime: execution.endTime,
        duration: execution.endTime ? execution.endTime - execution.startTime : undefined,
        completedSteps: execution.completedSteps,
        failedSteps: execution.failedSteps,
        variables: execution.variables,
        results: execution.results,
        errors: execution.errors,
        stepCount: workflow.steps.length
      };

      return createSuccessResponse(result);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('Workflow execution failed:', error);
      
      return createErrorResponse(`Workflow execution failed: ${errorMessage}`);
    }
  }

  /**
   * Validate workflow definition
   */
  private validateWorkflow(workflow: WorkflowDefinition): { valid: boolean; error?: string } {
    // Check for duplicate step IDs
    const stepIds = workflow.steps.map(s => s.id);
    const duplicates = stepIds.filter((id, index) => stepIds.indexOf(id) !== index);
    if (duplicates.length > 0) {
      return { valid: false, error: `Duplicate step IDs found: ${duplicates.join(', ')}` };
    }

    // Check dependencies reference valid steps
    for (const step of workflow.steps) {
      if (step.depends) {
        for (const dep of step.depends) {
          if (!stepIds.includes(dep)) {
            return { valid: false, error: `Step ${step.id} depends on non-existent step: ${dep}` };
          }
        }
      }
    }

    // Check for circular dependencies (basic check)
    const visited = new Set<string>();
    const visiting = new Set<string>();
    
    const checkCycles = (stepId: string): boolean => {
      if (visiting.has(stepId)) return true;
      if (visited.has(stepId)) return false;

      visiting.add(stepId);
      
      const step = workflow.steps.find(s => s.id === stepId);
      if (step?.depends) {
        for (const dep of step.depends) {
          if (checkCycles(dep)) return true;
        }
      }
      
      visiting.delete(stepId);
      visited.add(stepId);
      return false;
    };

    for (const stepId of stepIds) {
      if (checkCycles(stepId)) {
        return { valid: false, error: `Circular dependency detected involving step: ${stepId}` };
      }
    }

    return { valid: true };
  }
}

/**
 * Tool for saving workflow templates
 */
class WorkflowTemplateSaveTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_SAVE;

  async execute(args: {
    name: string;
    description?: string;
    workflow: WorkflowDefinition;
    category?: string;
    tags?: string[];
  }): Promise<ToolResult> {
    try {
      const { name, description, workflow, category, tags } = args;

      if (!name || !workflow) {
        return createErrorResponse('Template name and workflow are required');
      }

      const template: WorkflowTemplate = {
        name,
        description,
        workflow,
        category,
        tags,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await templateStorage.saveTemplate(template);

      const result = {
        success: true,
        message: `Workflow template '${name}' saved successfully`,
        template: {
          name: template.name,
          description: template.description,
          category: template.category,
          tags: template.tags,
          stepCount: workflow.steps.length,
          createdAt: template.createdAt
        }
      };

      return createSuccessResponse(result);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Failed to save template: ${errorMessage}`);
    }
  }
}

/**
 * Tool for loading workflow templates
 */
class WorkflowTemplateLoadTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WORKFLOW_TEMPLATE_LOAD;

  async execute(args: {
    name: string;
    variables?: Record<string, any>;
  }): Promise<ToolResult> {
    try {
      const { name, variables } = args;

      if (!name) {
        return createErrorResponse('Template name is required');
      }

      const template = await templateStorage.loadTemplate(name);
      if (!template) {
        // List available templates for help
        const available = await templateStorage.listTemplates();
        const templateNames = available.map(t => t.name).join(', ');
        
        return createErrorResponse(
          `Template '${name}' not found. Available templates: ${templateNames || 'none'}`
        );
      }

      // Merge provided variables with template variables
      const mergedVariables = {
        ...template.workflow.variables,
        ...variables
      };

      const workflow: WorkflowDefinition = {
        ...template.workflow,
        variables: mergedVariables
      };

      const result = {
        success: true,
        template: {
          name: template.name,
          description: template.description,
          category: template.category,
          tags: template.tags,
          createdAt: template.createdAt,
          updatedAt: template.updatedAt
        },
        workflow,
        message: `Template '${name}' loaded successfully`
      };

      return createSuccessResponse(result);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Failed to load template: ${errorMessage}`);
    }
  }
}

/**
 * Tool for waiting for specific conditions
 */
class WaitForConditionTool extends BaseBrowserToolExecutor {
  name = TOOL_NAMES.BROWSER.WAIT_FOR_CONDITION;

  async execute(args: { condition: WaitCondition }): Promise<ToolResult> {
    try {
      const { condition } = args;

      if (!condition || !condition.type) {
        return createErrorResponse('Condition is required with a valid type');
      }

      console.log(`Waiting for condition: ${condition.type}`);
      const startTime = Date.now();

      await this.waitForCondition(condition);

      const duration = Date.now() - startTime;
      const result = {
        success: true,
        message: `Condition met: ${condition.type}`,
        condition,
        waitTime: duration
      };

      return createSuccessResponse(result);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Wait condition failed: ${errorMessage}`);
    }
  }

  /**
   * Wait for condition implementation
   */
  private async waitForCondition(condition: WaitCondition): Promise<void> {
    const timeout = condition.timeout || 30000;
    const interval = condition.interval || 500;
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      try {
        let conditionMet = false;

        switch (condition.type) {
          case 'element_state':
            conditionMet = await this.checkElementState(condition);
            break;
            
          case 'network_idle':
            conditionMet = await this.checkNetworkIdle();
            break;
            
          case 'navigation':
            conditionMet = await this.checkNavigation(condition);
            break;
            
          case 'page_load':
            conditionMet = await this.checkPageLoad();
            break;
            
          case 'custom_js':
            conditionMet = await this.checkCustomJavaScript(condition);
            break;
        }

        if (conditionMet) {
          return;
        }

        await new Promise(resolve => setTimeout(resolve, interval));
      } catch (error) {
        console.warn(`Error checking condition: ${error}`);
        await new Promise(resolve => setTimeout(resolve, interval));
      }
    }

    throw new Error(`Condition timeout: ${condition.type} after ${timeout}ms`);
  }

  /**
   * Check element state conditions
   */
  private async checkElementState(condition: WaitCondition): Promise<boolean> {
    if (!condition.selector) {
      throw new Error('Element condition requires selector');
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return false;

      // Inject content script to check element state
      await this.injectContentScript(tabs[0].id, ['inject-scripts/interactive-elements-helper.js']);

      const result = await this.sendMessageToTab(tabs[0].id, {
        action: 'check_element_state',
        selector: condition.selector,
        state: condition.state,
        text: condition.text
      });

      return result?.conditionMet === true;
    } catch (error) {
      console.error('Error checking element state:', error);
      return false;
    }
  }

  /**
   * Check network idle state
   */
  private async checkNetworkIdle(): Promise<boolean> {
    // Simple implementation - could be enhanced with actual network monitoring
    return new Promise(resolve => {
      setTimeout(() => resolve(true), 1000);
    });
  }

  /**
   * Check navigation conditions
   */
  private async checkNavigation(condition: WaitCondition): Promise<boolean> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]) return false;

      if (condition.url) {
        return tabs[0].url?.includes(condition.url) || false;
      }

      // Check if page is loaded
      return tabs[0].status === 'complete';
    } catch {
      return false;
    }
  }

  /**
   * Check page load state
   */
  private async checkPageLoad(): Promise<boolean> {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      return tabs[0]?.status === 'complete' || false;
    } catch {
      return false;
    }
  }

  /**
   * Execute custom JavaScript condition
   */
  private async checkCustomJavaScript(condition: WaitCondition): Promise<boolean> {
    if (!condition.javascript) {
      throw new Error('Custom JavaScript condition requires javascript property');
    }

    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0]?.id) return false;

      const results = await chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        func: (js: string) => {
          try {
            return eval(js);
          } catch (error) {
            console.error('JavaScript condition error:', error);
            return false;
          }
        },
        args: [condition.javascript]
      });

      return results[0]?.result === true;
    } catch (error) {
      console.error('Error executing custom JavaScript:', error);
      return false;
    }
  }
}

export const workflowExecuteTool = new WorkflowExecuteTool();
export const workflowTemplateSaveTool = new WorkflowTemplateSaveTool();
export const workflowTemplateLoadTool = new WorkflowTemplateLoadTool();
export const waitForConditionTool = new WaitForConditionTool();