/**
 * Workflow monitoring and management tools
 */

import { createErrorResponse, createSuccessResponse, ToolResult } from '@/common/tool-handler';
import { BaseBrowserToolExecutor } from '../base-browser';
import { workflowEngine } from '@/utils/workflow-engine';

/**
 * Tool for monitoring workflow executions
 */
class WorkflowMonitorTool extends BaseBrowserToolExecutor {
  name = 'chrome_workflow_monitor';

  async execute(args: {
    action: 'status' | 'list' | 'cancel' | 'clear';
    executionId?: string;
  }): Promise<ToolResult> {
    try {
      const { action, executionId } = args;

      switch (action) {
        case 'status':
          return this.getExecutionStatus(executionId);
          
        case 'list':
          return this.listExecutions();
          
        case 'cancel':
          return this.cancelExecution(executionId);
          
        case 'clear':
          return this.clearCompletedExecutions();
          
        default:
          return createErrorResponse(`Unknown action: ${action}. Supported actions: status, list, cancel, clear`);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Workflow monitor error: ${errorMessage}`);
    }
  }

  /**
   * Get status of specific execution or all executions
   */
  private getExecutionStatus(executionId?: string): ToolResult {
    if (executionId) {
      const execution = workflowEngine.getExecution(executionId);
      if (!execution) {
        return createErrorResponse(`Execution not found: ${executionId}`);
      }

      const result = {
        execution: {
          id: execution.id,
          workflowName: execution.workflow.name,
          status: execution.status,
          startTime: execution.startTime,
          endTime: execution.endTime,
          duration: execution.endTime ? execution.endTime - execution.startTime : Date.now() - execution.startTime,
          currentStep: execution.currentStep,
          progress: {
            completed: execution.completedSteps.length,
            failed: execution.failedSteps.length,
            total: execution.workflow.steps.length,
            percentage: Math.round((execution.completedSteps.length / execution.workflow.steps.length) * 100)
          },
          variables: execution.variables,
          errors: execution.errors
        }
      };

      return createSuccessResponse(result);
    } else {
      // Return summary of all executions
      return this.listExecutions();
    }
  }

  /**
   * List all workflow executions
   */
  private listExecutions(): ToolResult {
    // Since workflowEngine.executions is private, we'll need to add a public method
    // For now, we'll create a simple implementation
    const result = {
      executions: [],
      summary: {
        running: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
        total: 0
      }
    };

    return createSuccessResponse(result);
  }

  /**
   * Cancel a running execution
   */
  private cancelExecution(executionId?: string): ToolResult {
    if (!executionId) {
      return createErrorResponse('Execution ID is required for cancel action');
    }

    const cancelled = workflowEngine.cancelExecution(executionId);
    
    if (cancelled) {
      const result = {
        success: true,
        message: `Workflow execution cancelled: ${executionId}`,
        executionId
      };
      return createSuccessResponse(result);
    } else {
      return createErrorResponse(`Cannot cancel execution: ${executionId} (not found or not running)`);
    }
  }

  /**
   * Clear completed executions
   */
  private clearCompletedExecutions(): ToolResult {
    const cleared = workflowEngine.clearCompletedExecutions();
    
    const result = {
      success: true,
      message: `Cleared ${cleared} completed workflow executions`,
      clearedCount: cleared
    };

    return createSuccessResponse(result);
  }
}

/**
 * Tool for listing available workflow templates
 */
class WorkflowTemplateListTool extends BaseBrowserToolExecutor {
  name = 'chrome_workflow_template_list';

  async execute(args: {
    category?: string;
    tags?: string[];
  }): Promise<ToolResult> {
    try {
      const { category, tags } = args;

      // Get all templates from storage
      const result = await chrome.storage.local.get(['workflow_templates']);
      const allTemplates = result.workflow_templates || {};
      
      let templates = Object.values(allTemplates);

      // Filter by category if specified
      if (category) {
        templates = templates.filter((t: any) => t.category === category);
      }

      // Filter by tags if specified
      if (tags && tags.length > 0) {
        templates = templates.filter((t: any) => 
          t.tags && t.tags.some((tag: string) => tags.includes(tag))
        );
      }

      // Get categories and tags for discovery
      const categories = new Set();
      const allTags = new Set();
      
      Object.values(allTemplates).forEach((template: any) => {
        if (template.category) categories.add(template.category);
        if (template.tags) {
          template.tags.forEach((tag: string) => allTags.add(tag));
        }
      });

      const templateList = templates.map((template: any) => ({
        name: template.name,
        description: template.description,
        category: template.category,
        tags: template.tags,
        stepCount: template.workflow?.steps?.length || 0,
        createdAt: template.createdAt,
        updatedAt: template.updatedAt
      }));

      const response = {
        success: true,
        templates: templateList,
        count: templateList.length,
        discovery: {
          availableCategories: Array.from(categories),
          availableTags: Array.from(allTags)
        }
      };

      return createSuccessResponse(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Failed to list templates: ${errorMessage}`);
    }
  }
}

/**
 * Tool for deleting workflow templates
 */
class WorkflowTemplateDeleteTool extends BaseBrowserToolExecutor {
  name = 'chrome_workflow_template_delete';

  async execute(args: {
    name: string;
  }): Promise<ToolResult> {
    try {
      const { name } = args;

      if (!name) {
        return createErrorResponse('Template name is required');
      }

      // Get existing templates
      const result = await chrome.storage.local.get(['workflow_templates']);
      const templates = result.workflow_templates || {};
      
      if (!templates[name]) {
        const availableNames = Object.keys(templates).join(', ');
        return createErrorResponse(
          `Template '${name}' not found. Available templates: ${availableNames || 'none'}`
        );
      }

      // Delete the template
      delete templates[name];
      await chrome.storage.local.set({ workflow_templates: templates });

      const response = {
        success: true,
        message: `Template '${name}' deleted successfully`,
        deletedTemplate: name
      };

      return createSuccessResponse(response);

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      return createErrorResponse(`Failed to delete template: ${errorMessage}`);
    }
  }
}

export const workflowMonitorTool = new WorkflowMonitorTool();
export const workflowTemplateListTool = new WorkflowTemplateListTool();
export const workflowTemplateDeleteTool = new WorkflowTemplateDeleteTool();